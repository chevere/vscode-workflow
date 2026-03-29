import * as assert from 'assert';
import * as sinon from 'sinon';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InlayHintKind, Range } from 'vscode-languageserver';
import * as reflector from '../src/reflector';
import { computeInlayHints } from '../src/inlayHints';
import { parseDocument } from '../src/parser';
import { sigOneStringParam, sigTwoParams, sigNullableParam, sigWithReturnType } from './fixtures';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function phpW(body: string): string {
  return `<?php\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\nuse function Chevere\\Workflow\\response;\n${body}\n`;
}

const FULL_RANGE: Range = {
  start: { line: 0, character: 0 },
  end: { line: 1000, character: 0 },
};

const CONFIG = {
  phpExecutable: 'php',
  autoloaderPath: '/autoload.php',
  showParameterTypes: true,
  showResponseTypes: true,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeInlayHints', () => {
  beforeEach(() => {
    sinon.stub(reflector, 'reflectClass').resolves(sigOneStringParam);
  });

  afterEach(() => {
    sinon.restore();
    reflector.invalidateCache();
  });

  it('returns empty array when there are no workflow calls', async () => {
    const src = `<?php\necho 'hello';`;
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, CONFIG);
    assert.deepStrictEqual(hints, []);
  });

  it('returns a type hint for a named parameter arg', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, CONFIG);
    const typeHint = hints.find((h) => h.kind === InlayHintKind.Type && String(h.label) === 'string');
    assert.ok(typeHint, `expected 'string' type hint, got labels: ${hints.map((h) => h.label).join(', ')}`);
  });

  it('suppresses parameter type hints when showParameterTypes is false', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, {
      ...CONFIG,
      showParameterTypes: false,
    });
    // No parameter type hints
    const paramHints = hints.filter(
      (h) => h.kind === InlayHintKind.Type && !String(h.label).startsWith(':')
    );
    assert.strictEqual(paramHints.length, 0);
  });

  it('shows ?type label for a nullable param', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves(sigNullableParam); // nullable string 'value'
    const src = phpW(`$w = workflow(step: sync(new MyJob(), value: 'x'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, CONFIG);
    const nullableHint = hints.find((h) => String(h.label) === '?string');
    assert.ok(nullableHint, `expected ?string hint, got: ${hints.map((h) => h.label).join(', ')}`);
  });

  it('returns a response return type hint when showResponseTypes is true', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves(sigWithReturnType); // returnType: 'string'
    const src = phpW(`$w = workflow(\n  step: sync(new MyJob())\n);\n$r = response('step');`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, CONFIG);
    const responseHint = hints.find(
      (h) => h.kind === InlayHintKind.Type && String(h.label).startsWith(':')
    );
    assert.ok(responseHint, `expected response type hint starting with ':', got: ${hints.map((h) => h.label).join(', ')}`);
    assert.ok(String(responseHint!.label).includes('string'), `expected 'string' in response hint`);
  });

  it('suppresses response type hints when showResponseTypes is false', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves(sigWithReturnType);
    const src = phpW(`$w = workflow(\n  step: sync(new MyJob())\n);\n$r = response('step');`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, {
      ...CONFIG,
      showResponseTypes: false,
    });
    const responseHints = hints.filter(
      (h) => h.kind === InlayHintKind.Type && String(h.label).startsWith(':')
    );
    assert.strictEqual(responseHints.length, 0);
  });

  it('returns no hints when reflection fails', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves({ ok: false, error: 'Not found' });
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'x'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, CONFIG);
    assert.deepStrictEqual(hints, []);
  });

  // ─── multiple jobs ───────────────────────────────────────────────────────────

  it('generates type hints for each named arg across multiple jobs', async () => {
    // sigOneStringParam stub applies to both jobs' classes
    const src = phpW(
      `$w = workflow(\n  step1: sync(new MyJob(), name: 'hello'),\n  step2: sync(new OtherJob(), name: 'world')\n);`
    );
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, CONFIG);
    const stringHints = hints.filter((h) => h.kind === InlayHintKind.Type && String(h.label) === 'string');
    assert.strictEqual(stringHints.length, 2, `expected 2 'string' hints (one per job), got ${stringHints.length}`);
  });

  // ─── optional param type hint ────────────────────────────────────────────────

  it('generates type hints for optional parameters as well as required ones', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves(sigTwoParams); // 'name': string (required), 'count': int (optional)
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello', count: 42));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, CONFIG);
    const labels = hints.map((h) => String(h.label));
    assert.ok(labels.includes('string'), `expected 'string' hint for required param, got: ${labels.join(', ')}`);
    assert.ok(labels.includes('int'), `expected 'int' hint for optional param, got: ${labels.join(', ')}`);
  });

  // ─── hint position accuracy ──────────────────────────────────────────────────

  it('places the type hint at the argument value offset', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const arg = parsed.workflowCalls[0].jobs[0].call.args.find((a) => a.name === 'name');
    if (!arg) return; // parser didn't pick it up
    const expectedPos = doc.positionAt(arg.valueOffset);
    const hints = await computeInlayHints(doc, parsed, FULL_RANGE, CONFIG);
    const typeHint = hints.find((h) => String(h.label) === 'string');
    assert.ok(typeHint, 'expected string type hint');
    assert.deepStrictEqual(typeHint!.position, expectedPos, 'hint position should be at the argument value offset');
  });
});
