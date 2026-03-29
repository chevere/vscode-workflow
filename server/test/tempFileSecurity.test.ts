import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reflectClass } from '../src/reflector';
import { validateAttribute } from '../src/validator';
import { lintWorkflow } from '../src/linter';

/**
 * Security tests for CWE-377 (Insecure Temporary File).
 *
 * These tests FAIL on the original code (PHP helpers written to predictable
 * flat paths directly in os.tmpdir()) and PASS after the fix (all PHP helpers
 * live inside a per-process private directory with mode 0700).
 *
 * Strategy: delete any leftover predictable files from previous runs, trigger
 * module initialization via real calls, then assert the predictable flat paths
 * were never created. Each `npm test` starts a fresh Node process, so the
 * modules initialize from scratch and the assertions reflect the current code.
 */

const PREDICTABLE = {
  reflect:  path.join(os.tmpdir(), 'chevere_workflow_reflect.php'),
  validate: path.join(os.tmpdir(), 'chevere_workflow_validate.php'),
  lint:     path.join(os.tmpdir(), 'chevere_workflow_lint.php'),
  mermaid:  path.join(os.tmpdir(), 'chevere_workflow_mermaid.php'),
};

describe('temp file security — CWE-377', () => {
  before(async function () {
    this.timeout(15000);
    // Remove any predictable files left over from pre-fix runs so assertions
    // reflect the current process only, not stale filesystem state.
    for (const p of Object.values(PREDICTABLE)) {
      try { fs.unlinkSync(p); } catch { /* absent is fine */ }
    }
    // Initialize all three modules so their getScriptPath() runs once.
    await reflectClass('php', '/nonexistent/autoload.php', 'Foo').catch(() => {});
    await validateAttribute('php', '/nonexistent/autoload.php', 'Attr', {}, 'val').catch(() => {});
    await lintWorkflow('php', '/nonexistent/autoload.php', 'MyWorkflow').catch(() => {});
  });

  // ─── static script paths ──────────────────────────────────────────────────

  it('reflector does NOT write PHP helper to a predictable flat path in tmpdir', () => {
    assert.strictEqual(fs.existsSync(PREDICTABLE.reflect), false,
      `PHP reflect helper must not exist at: ${PREDICTABLE.reflect}`);
  });

  it('validator does NOT write PHP helper to a predictable flat path in tmpdir', () => {
    assert.strictEqual(fs.existsSync(PREDICTABLE.validate), false,
      `PHP validate helper must not exist at: ${PREDICTABLE.validate}`);
  });

  it('linter does NOT write PHP helper to a predictable flat path in tmpdir', () => {
    assert.strictEqual(fs.existsSync(PREDICTABLE.lint), false,
      `PHP lint helper must not exist at: ${PREDICTABLE.lint}`);
  });

  it('jobGraph does NOT write Mermaid PHP helper to a predictable flat path in tmpdir', () => {
    assert.strictEqual(fs.existsSync(PREDICTABLE.mermaid), false,
      `Mermaid PHP helper must not exist at: ${PREDICTABLE.mermaid}`);
  });

  // ─── private temp directory ────────────────────────────────────────────────

  it('creates a private chevere-* temp directory instead of flat files', () => {
    const privateDir = fs.readdirSync(os.tmpdir()).find(n => n.startsWith('chevere-'));
    assert.ok(privateDir !== undefined,
      'Expected a private chevere-* temp directory to be created inside tmpdir');
  });

  it('private temp directory has mode 0700', () => {
    const privateDirName = fs.readdirSync(os.tmpdir()).find(n => n.startsWith('chevere-'));
    if (!privateDirName) return; // guarded by the previous test
    const mode = fs.statSync(path.join(os.tmpdir(), privateDirName)).mode & 0o777;
    assert.strictEqual(mode, 0o700,
      `Private temp dir must have mode 0700, got ${mode.toString(8)}`);
  });
});
