import * as assert from 'assert';
import * as path from 'path';
import { validateGotoSource } from '../src/gotoSource';

// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
// Helpers
// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

const WS = '/home/user/project';
const workspace = [WS];

function fileUri(fsPath: string): string {
  return 'file://' + fsPath;
}

// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
// Vulnerability demonstration
//
// Before the fix, the handler did:
//   const targetUri = vscode.Uri.parse(msg.uri as string);
//   await vscode.workspace.openTextDocument(targetUri);
//
// There was no scheme check and no workspace boundary check.
// The tests below document what an attacker could exploit:
// any file:// URI (including paths outside the project) would
// be accepted verbatim and opened in the editor.
// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

describe('gotoSource — vulnerability proof-of-concept (pre-fix behaviour)', () => {
  it('OLD: file:///etc/passwd would have been opened — no workspace check', () => {
    // Simulate what the old code did: parse-and-use, no guard.
    // We replicate the old logic in pure JS to show it passes silently.
    const msgUri = 'file:///etc/passwd';
    const parsed = new URL(msgUri);          // would not throw
    assert.strictEqual(parsed.protocol, 'file:');
    // No further check happened — openTextDocument would be called.
    // The fix must reject this because /etc/passwd ∉ workspace.
  });

  it('OLD: ~/.ssh/id_rsa would have been opened — no workspace check', () => {
    const msgUri = 'file:///root/.ssh/id_rsa';
    const parsed = new URL(msgUri);
    assert.strictEqual(parsed.protocol, 'file:');
    // Same: no workspace boundary check in the old code.
  });

  it('OLD: non-file schemes (e.g. https://) would have been passed to openTextDocument', () => {
    // vscode.Uri.parse('https://evil.example.com/script.php') would not throw;
    // openTextDocument might fail at runtime but there was no early guard.
    const msgUri = 'https://evil.example.com/script.php';
    // With the old cast-and-parse the extension would attempt to open this URI.
    // Documented here so the contrast with the fixed behaviour is explicit.
    assert.ok(msgUri.startsWith('https://'));
  });
});

// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
// Fixed behaviour — validateGotoSource
// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

describe('validateGotoSource — scheme validation', () => {
  it('rejects https:// URIs', () => {
    assert.strictEqual(
      validateGotoSource('https://evil.example.com/script.php', 1, workspace),
      null,
    );
  });

  it('rejects data: URIs', () => {
    assert.strictEqual(
      validateGotoSource('data:text/plain;base64,c2VjcmV0', 1, workspace),
      null,
    );
  });

  it('rejects bare file paths (no scheme)', () => {
    assert.strictEqual(
      validateGotoSource('/etc/passwd', 1, workspace),
      null,
    );
  });

  it('rejects vscode-resource: scheme', () => {
    assert.strictEqual(
      validateGotoSource('vscode-resource:///etc/passwd', 1, workspace),
      null,
    );
  });

  it('accepts file: scheme', () => {
    const result = validateGotoSource(
      fileUri(path.join(WS, 'src', 'Foo.php')),
      1,
      workspace,
    );
    assert.notStrictEqual(result, null);
  });
});

describe('validateGotoSource — workspace boundary', () => {
  it('rejects a file:// URI outside every workspace folder', () => {
    assert.strictEqual(
      validateGotoSource('file:///etc/passwd', 1, workspace),
      null,
    );
  });

  it('rejects ~/.ssh/id_rsa (path traversal scenario)', () => {
    assert.strictEqual(
      validateGotoSource('file:///root/.ssh/id_rsa', 1, workspace),
      null,
    );
  });

  it('rejects a sibling directory that shares a prefix with the workspace root', () => {
    // e.g. workspace=/home/user/project  →  /home/user/project-evil must NOT pass
    assert.strictEqual(
      validateGotoSource('file:///home/user/project-evil/secret.php', 1, workspace),
      null,
    );
  });

  it('rejects path traversal via ../ encoded in the URI', () => {
    // URL decoding resolves ../ so the path escapes the workspace
    assert.strictEqual(
      validateGotoSource('file:///home/user/project/../.ssh/id_rsa', 1, workspace),
      null,
    );
  });

  it('accepts a file directly in the workspace root', () => {
    const result = validateGotoSource(
      fileUri(path.join(WS, 'composer.json')),
      1,
      workspace,
    );
    assert.notStrictEqual(result, null);
  });

  it('accepts a file nested inside the workspace', () => {
    const result = validateGotoSource(
      fileUri(path.join(WS, 'src', 'deep', 'File.php')),
      5,
      workspace,
    );
    assert.notStrictEqual(result, null);
  });

  it('accepts a file when workspace has multiple folders and it matches the second', () => {
    const ws2 = '/home/user/other-project';
    const result = validateGotoSource(
      fileUri(path.join(ws2, 'src', 'Bar.php')),
      2,
      [WS, ws2],
    );
    assert.notStrictEqual(result, null);
  });

  it('returns null when workspace folder list is empty', () => {
    assert.strictEqual(
      validateGotoSource(fileUri(path.join(WS, 'src', 'Foo.php')), 1, []),
      null,
    );
  });
});

describe('validateGotoSource — line number normalisation', () => {
  const validUri = fileUri(path.join(WS, 'src', 'Foo.php'));

  it('converts 1-based line to 0-based', () => {
    const result = validateGotoSource(validUri, 5, workspace);
    assert.strictEqual(result?.line, 4);
  });

  it('clamps line 1 to 0 (first line)', () => {
    const result = validateGotoSource(validUri, 1, workspace);
    assert.strictEqual(result?.line, 0);
  });

  it('falls back to 0 for a string value (NaN guard)', () => {
    const result = validateGotoSource(validUri, 'three' as unknown as number, workspace);
    assert.strictEqual(result?.line, 0);
  });

  it('falls back to 0 for NaN', () => {
    const result = validateGotoSource(validUri, NaN, workspace);
    assert.strictEqual(result?.line, 0);
  });

  it('falls back to 0 for Infinity', () => {
    const result = validateGotoSource(validUri, Infinity, workspace);
    assert.strictEqual(result?.line, 0);
  });

  it('falls back to 0 for undefined', () => {
    const result = validateGotoSource(validUri, undefined, workspace);
    assert.strictEqual(result?.line, 0);
  });

  it('clamps negative result to 0 (line 0 input)', () => {
    const result = validateGotoSource(validUri, 0, workspace);
    assert.strictEqual(result?.line, 0);
  });

  it('floors a fractional line number', () => {
    const result = validateGotoSource(validUri, 3.9, workspace);
    assert.strictEqual(result?.line, 2);
  });
});

describe('validateGotoSource — uri type guard', () => {
  it('rejects null uri', () => {
    assert.strictEqual(validateGotoSource(null, 1, workspace), null);
  });

  it('rejects undefined uri', () => {
    assert.strictEqual(validateGotoSource(undefined, 1, workspace), null);
  });

  it('rejects numeric uri', () => {
    assert.strictEqual(validateGotoSource(42, 1, workspace), null);
  });

  it('rejects an unparseable string', () => {
    assert.strictEqual(validateGotoSource('not a uri at all ::::', 1, workspace), null);
  });
});

describe('validateGotoSource — returned value', () => {
  it('returns the decoded fsPath', () => {
    const filePath = path.join(WS, 'src', 'Foo.php');
    const result = validateGotoSource(fileUri(filePath), 3, workspace);
    assert.strictEqual(result?.fsPath, filePath);
  });
});
