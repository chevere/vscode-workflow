import * as path from 'path';

/**
 * Validates a gotoSource WebView message before acting on it.
 *
 * Returns `{ fsPath, line }` only when:
 *   - `uriString` is a string parseable as a `file:` URI
 *   - the resolved fs-path is within one of `workspaceFsPaths`
 *
 * `line` is the 0-based editor line (msg.line is 1-based); non-numeric
 * or out-of-range values fall back to 0.
 */
export function validateGotoSource(
  uriString: unknown,
  lineValue: unknown,
  workspaceFsPaths: string[],
): { fsPath: string; line: number } | null {
  if (typeof uriString !== 'string') return null;

  let scheme: string;
  let fsPath: string;
  try {
    const parsed = new URL(uriString);
    scheme = parsed.protocol.replace(/:$/, '');
    // On Windows URL.pathname is /C:/foo — keep as-is; path.sep handles sep
    fsPath = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  if (scheme !== 'file') return null;

  const inWorkspace = workspaceFsPaths.some(
    root => fsPath === root || fsPath.startsWith(root + path.sep),
  );
  if (!inWorkspace) return null;

  const line =
    typeof lineValue === 'number' && isFinite(lineValue)
      ? Math.max(0, Math.floor(lineValue) - 1)
      : 0;

  return { fsPath, line };
}
