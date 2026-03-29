import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LINT_PHP_SCRIPT } from './lintScript';
import { sanitizePhpExecutable } from './phpExecutable';
import { getTempDir } from './tempDir';

export interface LintViolation {
  job: string;
  message: string;
  /** Present for parameter (arg constraint) violations */
  parameter?: string;
  /** Present when the violation is tied to a specific chain method */
  method?: 'withRunIf' | 'withRunIfNot' | 'withDepends';
  /** Present for withDepends violations: the job names that were not found */
  missing?: string[];
  /** Present when the violation targets a variable() reference */
  variable?: string;
  /** Present when the violation targets a response() reference, e.g. "ja->key" or "j0" */
  response?: string;
}

/**
 * Schema data for a workflow variable, taken from chevere/parameter.
 * Each parameter type may include different constraint fields (min, max, accept, reject, etc.).
 */
export interface VariableSchema {
  required: boolean;
  type: string;
  description?: string;
  default?: unknown;
  /** For className type: the fully-qualified class name */
  className?: string;
  /** For numeric types: minimum value */
  min?: number;
  /** For numeric types: maximum value */
  max?: number;
  /** For string/enum types: accepted values */
  accept?: unknown[];
  /** For string/enum types: rejected values */
  reject?: unknown[];
  [key: string]: unknown;
}

export type LintResult =
  | { ok: true; violations: LintViolation[]; mermaid: string; variables?: Record<string, VariableSchema> }
  | { ok: false; error: string };

// Write the lint helper once per process to a temp file
let _scriptPath: string | null = null;
function getScriptPath(): string {
  if (!_scriptPath) {
    _scriptPath = path.join(getTempDir(), 'lint.php');
    fs.writeFileSync(_scriptPath, LINT_PHP_SCRIPT, { mode: 0o600 });
  }
  return _scriptPath;
}

// Cache keyed by autoloaderPath::className — invalidated on document save
const cache = new Map<string, LintResult>();

export function invalidateLintCache(className?: string) {
  if (className) {
    // Invalidate all entries for the given class (across any autoloader path)
    for (const key of cache.keys()) {
      if (key.endsWith(`::${className}`)) cache.delete(key);
    }
  } else {
    cache.clear();
  }
}

export function lintWorkflow(
  phpExecutable: string,
  autoloaderPath: string,
  className: string
): Promise<LintResult> {
  const cacheKey = `${autoloaderPath}::${className}`;
  if (cache.has(cacheKey)) {
    return Promise.resolve(cache.get(cacheKey)!);
  }

  return new Promise((resolve) => {
    execFile(
      sanitizePhpExecutable(phpExecutable),
      [getScriptPath(), autoloaderPath, className],
      { timeout: 10000, env: { ...process.env, CHEVERE_WORKFLOW_LINT_ENABLE: '1' } },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve({ ok: false, error: stderr || err.message });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim()) as LintResult;
          cache.set(cacheKey, result);
          resolve(result);
        } catch {
          resolve({ ok: false, error: `Failed to parse lint output: ${stdout}` });
        }
      }
    );
  });
}

/**
 * Lint the workflow from in-memory document source by writing a temp PHP file
 * with the class renamed to a unique name, so the unsaved editor content is linted.
 */
export function lintWorkflowSource(
  phpExecutable: string,
  autoloaderPath: string,
  className: string,
  source: string
): Promise<LintResult> {
  // Replace the class declaration name so we can load it alongside the real class
  const shortName = className.split('\\').pop() ?? className;
  const tempName = `__LspLint_${shortName}_${Date.now()}`;
  // Rename only the class declaration, not references inside the body
  const patched = source.replace(
    new RegExp(`((?:final\\s+|abstract\\s+|readonly\\s+)*class\\s+)${shortName}(\\s)`),
    `$1${tempName}$2`
  );
  const tmpFile = path.join(getTempDir(), `lint_src_${tempName}.php`);
  fs.writeFileSync(tmpFile, patched);

  // Build the FQCN for the temp class (same namespace, different short name)
  const ns = className.includes('\\') ? className.slice(0, className.lastIndexOf('\\')) : '';
  const tempFqcn = ns ? `${ns}\\${tempName}` : tempName;

  return new Promise((resolve) => {
    execFile(
      sanitizePhpExecutable(phpExecutable),
      [getScriptPath(), autoloaderPath, tempFqcn, tmpFile],
      { timeout: 10000, env: { ...process.env, CHEVERE_WORKFLOW_LINT_ENABLE: '1' } },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch { }
        if (err && !stdout) {
          resolve({ ok: false, error: stderr || err.message });
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as LintResult);
        } catch {
          resolve({ ok: false, error: `Failed to parse lint output: ${stdout}` });
        }
      }
    );
  });
}
