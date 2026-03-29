import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { REFLECT_PHP_SCRIPT } from './reflectScript';
import { sanitizePhpExecutable } from './phpExecutable';
import { getTempDir } from './tempDir';

export interface AttrInfo {
  /** Fully-qualified class name, e.g. "Chevere\\Parameter\\Attributes\\_string" */
  class: string;
  /** Unqualified name, e.g. "_string" */
  shortName: string;
  /** Constructor arguments keyed by name or position */
  args: Record<string, unknown>;
  /** Source representation for display, e.g. "#[_string('/regex/')]" */
  display: string;
}

export interface ParamInfo {
  name: string;
  type: string | null;
  nullable: boolean;
  hasDefault: boolean;
  default: string | null;
  position: number;
  variadic: boolean;
  attributes: AttrInfo[];
}

export interface ClassSignature {
  ok: true;
  class: string;
  method: string;
  params: ParamInfo[];
  returnType: string | null;
  /** For Chevere Actions: maps each acceptReturn() key to its PHP type. */
  returnKeys?: Record<string, string>;
  /** For plain class return types: maps each public property name to its PHP type. */
  returnClassProperties?: Record<string, string | null>;
}

export interface ReflectError {
  ok: false;
  error: string;
}

export type ReflectResult = ClassSignature | ReflectError;

// Write the reflect helper once per process to a temp file
let _scriptPath: string | null = null;
function getScriptPath(): string {
  if (!_scriptPath) {
    _scriptPath = path.join(getTempDir(), 'reflect.php');
    fs.writeFileSync(_scriptPath, REFLECT_PHP_SCRIPT, { mode: 0o600 });
  }
  return _scriptPath;
}

// Cache to avoid repeated reflection calls
const cache = new Map<string, ReflectResult>();

export function invalidateCache(className?: string) {
  if (className) {
    cache.delete(className);
  } else {
    cache.clear();
  }
}

export function reflectClass(
  phpExecutable: string,
  autoloaderPath: string,
  className: string,
  methodName?: string
): Promise<ReflectResult> {
  const cacheKey = `${autoloaderPath}::${className}${methodName ? `::${methodName}` : ''}`;
  if (cache.has(cacheKey)) {
    return Promise.resolve(cache.get(cacheKey)!);
  }

  return new Promise((resolve) => {
    const scriptPath = getScriptPath();
    const args = methodName
      ? [scriptPath, autoloaderPath, className, methodName]
      : [scriptPath, autoloaderPath, className];
    execFile(
      sanitizePhpExecutable(phpExecutable),
      args,
      { timeout: 5000, env: { ...process.env, CHEVERE_WORKFLOW_LINT_ENABLE: '1' } },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          const result: ReflectError = {
            ok: false,
            error: stderr || err.message,
          };
          resolve(result);
          return;
        }
        try {
          const result = JSON.parse(stdout.trim()) as ReflectResult;
          cache.set(cacheKey, result);
          resolve(result);
        } catch {
          resolve({ ok: false, error: `Failed to parse reflection output: ${stdout}` });
        }
      }
    );
  });
}
