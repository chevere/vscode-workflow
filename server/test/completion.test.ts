import * as assert from 'assert';
import * as sinon from 'sinon';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver';
import * as reflector from '../src/reflector';
import { computeCompletions } from '../src/completion';
import { parseDocument } from '../src/parser';
import { sigOneStringParam, sigMixedParams } from './fixtures';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function phpW(body: string): string {
  return `<?php\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n${body}\n`;
}

const CONFIG = { phpExecutable: 'php', autoloaderPath: '/autoload.php' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeCompletions', () => {
  beforeEach(() => {
    sinon.stub(reflector, 'reflectClass').resolves(sigMixedParams); // required + optional
  });

  afterEach(() => {
    sinon.restore();
    reflector.invalidateCache();
  });

  it('returns empty array when cursor is outside any workflow call', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), required: 'x'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    // Position well outside the call range
    const result = await computeCompletions(doc, { line: 0, character: 0 }, parsed, CONFIG);
    assert.deepStrictEqual(result, []);
  });

  it('returns completions for unset parameters when cursor is inside call', async () => {
    // Both params unset
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callEnd);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    assert.ok(result.length >= 2, `expected at least 2 completions, got ${result.length}`);
  });

  it('completion items have Field kind and snippet insert format', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callEnd);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    const paramItem = result.find((c) => c.kind === CompletionItemKind.Field);
    assert.ok(paramItem, 'expected at least one Field completion');
    assert.strictEqual(paramItem!.insertTextFormat, InsertTextFormat.Snippet);
    assert.ok(paramItem!.insertText?.includes('$0'), 'expected snippet placeholder');
  });

  it('sorts required params before optional (sortText starts with 0_ vs 1_)', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callEnd);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    const required = result.find((c) => c.sortText?.startsWith('0_'));
    const optional = result.find((c) => c.sortText?.startsWith('1_'));
    assert.ok(required, 'expected required param with sortText 0_...');
    assert.ok(optional, 'expected optional param with sortText 1_...');
  });

  it('excludes already-passed parameters from completions', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves(sigOneStringParam); // one param 'name'
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callEnd);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    // 'name' already passed — should not appear as a param completion
    const nameItem = result.find((c) => c.label === 'name:');
    assert.strictEqual(nameItem, undefined, 'already-passed param should be excluded');
  });

  it('offers response() completions for other jobs in the same workflow', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves(sigOneStringParam);
    const src = phpW(`$w = workflow(\n  job1: sync(new MyJob()),\n  job2: sync(new OtherJob())\n);`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    // Cursor inside job2's call
    const job2 = parsed.workflowCalls[0].jobs[1].call;
    const pos = doc.positionAt(job2.callEnd);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    const responseItem = result.find((c) => c.kind === CompletionItemKind.Reference);
    assert.ok(responseItem, 'expected response() completion item');
    assert.ok(responseItem!.label.includes('job1'), `expected job1 in response completion, got: ${responseItem!.label}`);
  });

  it('returns empty array when reflection fails', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves({ ok: false, error: 'Not found' });
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callEnd);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    assert.deepStrictEqual(result, []);
  });

  it('returns no response() completions for a single-job workflow (no other jobs to reference)', async () => {
    sinon.restore();
    sinon.stub(reflector, 'reflectClass').resolves(sigOneStringParam);
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callEnd);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    const responseItems = result.filter((c) => c.kind === CompletionItemKind.Reference);
    assert.strictEqual(responseItems.length, 0, 'single-job workflow should have no response() completions');
  });

  it('completion detail field includes type and required/optional label', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    const pos = doc.positionAt(call.callEnd);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    const requiredItem = result.find((c) => c.sortText?.startsWith('0_'));
    assert.ok(requiredItem, 'expected required completion item');
    assert.ok(requiredItem!.detail?.includes('required'), `expected 'required' in detail, got: ${requiredItem!.detail}`);
    const optionalItem = result.find((c) => c.sortText?.startsWith('1_'));
    assert.ok(optionalItem, 'expected optional completion item');
    assert.ok(optionalItem!.detail?.includes('optional'), `expected 'optional' in detail, got: ${optionalItem!.detail}`);
  });

  it('returns empty array when cursor is before the job call range starts', async () => {
    // Append trailing content so the document is long enough for offset math to be reliable.
    const src = phpW(`$w = workflow(step: sync(new MyJob()));\n// end`);
    const doc = TextDocument.create('file:///test.php', 'php', 1, src);
    const parsed = parseDocument(src);
    const call = parsed.workflowCalls[0].jobs[0].call;
    // One character before the sync() call starts — clearly outside the call range.
    const pos = doc.positionAt(call.callStart - 1);
    const result = await computeCompletions(doc, pos, parsed, CONFIG);
    assert.deepStrictEqual(result, []);
  });
});
