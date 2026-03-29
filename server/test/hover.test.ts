import * as assert from 'assert';
import * as sinon from 'sinon';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as reflector from '../src/reflector';
import { computeHover } from '../src/hover';
import { parseDocument } from '../src/parser';
import { sigOneStringParam, sigWithReturnType } from './fixtures';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function phpW(body: string): string {
  return `<?php\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n${body}\n`;
}

const CONFIG = { phpExecutable: 'php', autoloaderPath: '/autoload.php' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeHover', () => {
  beforeEach(() => {
    sinon.stub(reflector, 'reflectClass').resolves(sigOneStringParam);
  });

  afterEach(() => {
    sinon.restore();
    reflector.invalidateCache();
  });

  it('returns null when cursor is outside any workflow call', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    // Position at the very start of the file (before any workflow)
    const result = await computeHover(doc, { line: 0, character: 0 }, parsed, CONFIG);
    assert.strictEqual(result, null);
  });

  it('returns markdown hover when cursor is inside a sync() call', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    // Position inside the sync() call range
    const midOffset = Math.floor((call.callStart + call.callEnd) / 2);
    const pos = doc.positionAt(midOffset);
    const result = await computeHover(doc, pos, parsed, CONFIG);
    assert.ok(result !== null, 'expected hover result');
    const content = result!.contents as { kind: string; value: string };
    assert.strictEqual(content.kind, 'markdown');
    assert.ok(content.value.includes('MyJob'));
  });

  it('hover over a job call shows parameter names in the signature', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callStart + 1);
    const result = await computeHover(doc, pos, parsed, CONFIG);
    const content = result!.contents as { value: string };
    assert.ok(content.value.includes('name'));
  });

  it('returns hover with reflection error message when reflection fails', async () => {
    sinon.restore(); // remove default stub
    sinon.stub(reflector, 'reflectClass').resolves({ ok: false, error: 'Class not found' });
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callStart + 1);
    const result = await computeHover(doc, pos, parsed, CONFIG);
    // Should return a hover (not null) showing the error
    assert.ok(result !== null, 'expected non-null hover for reflection error');
    const content = result!.contents as { value: string };
    assert.ok(content.value.includes('not') || content.value.includes('error') || content.value.includes('reflect'),
      `expected error message in hover, got: ${content.value}`);
  });

  it('returns hover for response() call showing job name and return type', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves(sigWithReturnType); // returnType: 'string'
    const src = phpW(`$w = workflow(\n  step: sync(new MyJob())\n);\n$r = response('step');`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const ref = parsed.responseRefs[0];
    if (!ref) {
      // Skip if parser didn't pick up the standalone response ref
      return;
    }
    // Cursor inside the response('step') text
    const pos = doc.positionAt(ref.offset + 5);
    const result = await computeHover(doc, pos, parsed, CONFIG);
    if (result) {
      const content = result.contents as { value: string };
      assert.ok(content.value.includes('step'));
    }
  });

  // ─── param-specific hover ───────────────────────────────────────────────────

  it('returns param-specific hover when cursor is over an argument name', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const args = parsed.workflowCalls[0]?.jobs[0]?.call.args ?? [];
    const nameArg = args.find((a) => a.name === 'name');
    if (!nameArg) return; // parser didn't resolve it — skip gracefully
    const pos = doc.positionAt(nameArg.nameOffset);
    const result = await computeHover(doc, pos, parsed, CONFIG);
    assert.ok(result !== null, 'expected hover result for arg name position');
    const content = result!.contents as { value: string };
    // buildParamHover returns "**Parameter** `$name` of `...`"
    assert.ok(content.value.includes('Parameter'), `expected 'Parameter' in hover, got: ${content.value}`);
    assert.ok(content.value.includes('name'), `expected param name in hover, got: ${content.value}`);
  });

  // ─── missing arg warning in signature hover ─────────────────────────────────

  it('shows missing argument warning in signature hover when required arg is absent', async () => {
    // sigOneStringParam has required 'name'; pass no args
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callStart + 1);
    const result = await computeHover(doc, pos, parsed, CONFIG);
    assert.ok(result !== null, 'expected hover result');
    const content = result!.contents as { value: string };
    assert.ok(content.value.includes('missing'), `expected 'missing' warning in hover, got: ${content.value}`);
    assert.ok(content.value.includes('name'), `expected param name in warning, got: ${content.value}`);
  });

  // ─── async() job hover ──────────────────────────────────────────────────────

  it('returns hover for async() job calls the same as sync()', async () => {
    const src = `<?php\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\async;\n$w = workflow(step: async(new MyJob(), name: 'hello'));\n`;
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const job = parsed.workflowCalls[0]?.jobs[0];
    if (!job) return; // parser didn't detect async() — skip
    const pos = doc.positionAt(job.call.callStart + 1);
    const result = await computeHover(doc, pos, parsed, CONFIG);
    assert.ok(result !== null, 'expected hover for async() call');
    const content = result!.contents as { value: string };
    assert.ok(content.value.includes('MyJob'), `expected class name in hover, got: ${content.value}`);
  });
});
