import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { VALIDATE_PHP_SCRIPT } from './validateScript';
import { sanitizePhpExecutable } from './phpExecutable';
import { getTempDir } from './tempDir';

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

// Write the validate helper once per process to a temp file
let _scriptPath: string | null = null;
function getScriptPath(): string {
  if (!_scriptPath) {
    _scriptPath = path.join(getTempDir(), 'validate.php');
    fs.writeFileSync(_scriptPath, VALIDATE_PHP_SCRIPT, { mode: 0o600 });
  }
  return _scriptPath;
}

// Cache keyed on attrClass + argsJson + valueJson to avoid redundant subprocess calls
const cache = new Map<string, ValidateResult>();

export function validateAttribute(
  phpExecutable: string,
  autoloaderPath: string,
  attrClass: string,
  args: Record<string, unknown>,
  value: string | number | boolean | null,
  closureContext?: { filePath: string; jobName: string; paramName: string; enclosingClass?: string }
): Promise<ValidateResult> {
  const argsJson = JSON.stringify(args);
  const valueJson = JSON.stringify(value);
  const contextKey = closureContext
    ? `${closureContext.filePath}::${closureContext.jobName}::${closureContext.paramName}`
    : '';
  const cacheKey = `${attrClass}::${argsJson}::${valueJson}::${contextKey}`;

  if (cache.has(cacheKey)) {
    return Promise.resolve(cache.get(cacheKey)!);
  }

  return new Promise((resolve) => {
    const scriptArgs = [getScriptPath(), autoloaderPath, attrClass, argsJson, valueJson];
    if (closureContext !== undefined) {
      scriptArgs.push(closureContext.filePath, closureContext.jobName, closureContext.paramName);
      if (closureContext.enclosingClass) scriptArgs.push(closureContext.enclosingClass);
    }
    execFile(
      sanitizePhpExecutable(phpExecutable),
      scriptArgs,
      { timeout: 5000, env: { ...process.env, CHEVERE_WORKFLOW_LINT_ENABLE: '1' } },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          // Script-level failure — treat as ok to avoid false positives
          resolve({ ok: true });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim()) as ValidateResult;
          cache.set(cacheKey, result);
          resolve(result);
        } catch {
          resolve({ ok: true });
        }
      }
    );
  });
}
