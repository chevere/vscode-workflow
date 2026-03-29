/**
 * Returns true if `exe` is an acceptable PHP executable: a bare command name
 * (no path separators) whose value matches the php naming pattern.
 *
 * Valid:   php  php8  php8.3  php-8.3
 * Invalid: /usr/bin/php  /tmp/php  C:\php\php.exe  node  ./script.sh  (empty)
 *
 * Absolute paths are rejected entirely: validating only the basename
 * allows any executable whose last component starts with "php", regardless of
 * where it lives on disk.  Callers that genuinely need absolute paths should
 * manage their own allowlist outside this function.
 */
export function isValidPhpExecutable(exe: string): boolean {
  if (!exe) return false;
  if (exe.includes('/') || exe.includes('\\')) return false;
  return /^php[\w.-]*$/i.test(exe);
}

/**
 * Returns `exe` if it passes `isValidPhpExecutable`, otherwise falls back to
 * the literal string `"php"`.
 */
export function sanitizePhpExecutable(exe: string): string {
  return isValidPhpExecutable(exe) ? exe : 'php';
}
