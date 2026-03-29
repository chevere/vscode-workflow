import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Per-process private temp directory. Created once, mode 0700, cleaned on exit.
let _tempDir: string | null = null;

/**
 * Returns (and lazily creates) a per-process private temp directory.
 *
 * The directory is created with `mkdtempSync` (unique random suffix) and
 * immediately chmod'd to `0700` so only the owning OS user can read or write
 * inside it. Writing PHP helper scripts here instead of directly into
 * `os.tmpdir()` closes the CWE-377 pre-creation symlink and race-condition
 * attacks (CWE-377 pre-creation symlink and race-condition).
 */
export function getTempDir(): string {
  if (!_tempDir) {
    _tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chevere-'));
    fs.chmodSync(_tempDir, 0o700);
    process.on('exit', () => {
      try { fs.rmSync(_tempDir!, { recursive: true, force: true }); } catch { /* best-effort */ }
    });
  }
  return _tempDir;
}
