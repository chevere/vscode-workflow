import * as assert from 'assert';
import { validateOpenExternal } from '../src/openExternal';

// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
// Vulnerability demonstration (F-6)
//
// Before the fix, the WebView message handler did:
//   vscode.env.openExternal(vscode.Uri.parse(msg.url as string))
//
// msg.url was cast to string with no scheme check — any URI
// (file://, vscode://, javascript:, custom protocols) was handed
// straight to the OS default handler.
//
// The tests below document what an attacker could exploit when
// script injection is achieved in the WebView:
// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

describe('openExternal — vulnerability proof-of-concept (F-6, pre-fix behaviour)', () => {
  it('OLD: file:// URI would have been passed to openExternal without validation', () => {
    // Simulate the old unsafe cast: msg.url as string → openExternal
    const msgUrl = 'file:///etc/passwd';
    // Old code never called validateOpenExternal — it would just open it.
    // The fix MUST reject this. We assert the new guard rejects it.
    assert.strictEqual(
      validateOpenExternal(msgUrl),
      null,
      'file:// URI must be rejected — the old code would have opened a local file',
    );
  });

  it('OLD: vscode:// URI could trigger VS Code commands (e.g. reveal settings)', () => {
    const msgUrl = 'vscode://settings/chevereWorkflow.phpExecutable';
    assert.strictEqual(
      validateOpenExternal(msgUrl),
      null,
      'vscode:// URI must be rejected — the old code would have triggered a VS Code command',
    );
  });

  it('OLD: javascript: URI had unpredictable behaviour with OS handler', () => {
    const msgUrl = 'javascript:alert(1)';
    assert.strictEqual(
      validateOpenExternal(msgUrl),
      null,
      'javascript: URI must be rejected',
    );
  });

  it('OLD: custom protocol handlers (slack://, zoommtg://) could invoke desktop apps', () => {
    const msgUrl = 'slack://channel?id=C1234&team=T1234';
    assert.strictEqual(
      validateOpenExternal(msgUrl),
      null,
      'Custom protocol URI must be rejected',
    );
  });

  it('OLD: http:// (non-TLS) URL was accepted without restriction', () => {
    const msgUrl = 'http://evil.example.com/phish';
    assert.strictEqual(
      validateOpenExternal(msgUrl),
      null,
      'http:// must be rejected — only https:// is a legitimate scheme here',
    );
  });
});

// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
// Fixed behaviour — validateOpenExternal
// ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

describe('validateOpenExternal — scheme allowlist', () => {
  it('accepts a valid https:// URL', () => {
    const url = 'https://chevere.org/';
    assert.strictEqual(validateOpenExternal(url), url);
  });

  it('accepts an https:// URL with path and query', () => {
    const url = 'https://chevere.org/workflow?ref=vscode';
    assert.strictEqual(validateOpenExternal(url), url);
  });

  it('rejects file://', () => {
    assert.strictEqual(validateOpenExternal('file:///etc/passwd'), null);
  });

  it('rejects http://', () => {
    assert.strictEqual(validateOpenExternal('http://example.com'), null);
  });

  it('rejects vscode://', () => {
    assert.strictEqual(
      validateOpenExternal('vscode://settings/chevereWorkflow.phpExecutable'),
      null,
    );
  });

  it('rejects vscode-insiders://', () => {
    assert.strictEqual(
      validateOpenExternal('vscode-insiders://settings/foo'),
      null,
    );
  });

  it('rejects javascript: URI', () => {
    assert.strictEqual(validateOpenExternal('javascript:alert(1)'), null);
  });

  it('rejects custom protocol (slack://)', () => {
    assert.strictEqual(validateOpenExternal('slack://channel?id=C1&team=T1'), null);
  });

  it('rejects zoommtg://', () => {
    assert.strictEqual(validateOpenExternal('zoommtg://zoom.us/join?action=join'), null);
  });
});

describe('validateOpenExternal — input type guard', () => {
  it('rejects null', () => {
    assert.strictEqual(validateOpenExternal(null), null);
  });

  it('rejects undefined', () => {
    assert.strictEqual(validateOpenExternal(undefined), null);
  });

  it('rejects a number', () => {
    assert.strictEqual(validateOpenExternal(42), null);
  });

  it('rejects an object', () => {
    assert.strictEqual(validateOpenExternal({ url: 'https://chevere.org' }), null);
  });

  it('rejects an unparseable string', () => {
    assert.strictEqual(validateOpenExternal('not a url ::::'), null);
  });

  it('rejects an empty string', () => {
    assert.strictEqual(validateOpenExternal(''), null);
  });
});

describe('validateOpenExternal — return value', () => {
  it('returns the original URL string unchanged', () => {
    const url = 'https://chevere.org/workflow';
    const result = validateOpenExternal(url);
    assert.strictEqual(result, url);
  });
});
