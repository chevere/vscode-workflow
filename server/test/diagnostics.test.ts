import * as assert from 'assert';
import * as sinon from 'sinon';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver';
import * as reflector from '../src/reflector';
import * as validator from '../src/validator';
import * as linter from '../src/linter';
import { computeDiagnostics } from '../src/diagnostics';
import { parseDocument } from '../src/parser';
import {
  sigOneStringParam,
  sigNullableParam,
  sigMixedTypeParam,
  sigWithReturnKeys,
  sigWithAttr,
  sigVariadicParam,
} from './fixtures';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDoc(src: string) {
  return TextDocument.create('file:///test.php', 'php', 1, src);
}

function phpW(body: string): string {
  return `<?php\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\nuse function Chevere\\Workflow\\response;\n${body}\n`;
}

const CONFIG = { phpExecutable: 'php', autoloaderPath: '/autoload.php' };

// ─── Tests (all inside one describe to scope beforeEach/afterEach) ────────────

describe('computeDiagnostics', () => {
  let reflectStub: sinon.SinonStub;
  let validateStub: sinon.SinonStub;

  beforeEach(() => {
    reflectStub = sinon.stub(reflector, 'reflectClass').resolves(sigOneStringParam);
    validateStub = sinon.stub(validator, 'validateAttribute').resolves({ ok: true });
  });

  afterEach(() => {
    sinon.restore();
    reflector.invalidateCache();
  });

  // ─── valid workflow ─────────────────────────────────────────────────────────

  it('returns no diagnostics when required arg is satisfied', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.strictEqual(diags.length, 0);
  });

  it('returns no diagnostics when there are no workflowCalls', async () => {
    const src = `<?php\necho 'hello';`;
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.strictEqual(diags.length, 0);
    assert.strictEqual(reflectStub.callCount, 0);
  });

  // ─── missing required arg ───────────────────────────────────────────────────

  it('reports missing-required-arg for an absent required parameter', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].code, 'missing-required-arg');
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
    assert.ok(diags[0].message.includes('name'));
  });

  // ─── unknown arg ────────────────────────────────────────────────────────────

  it('reports unknown-arg for an argument not in the signature', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), unknown: 'val'));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    const d = diags.find((d) => d.code === 'unknown-arg');
    assert.ok(d, 'expected unknown-arg diagnostic');
    assert.strictEqual(d!.severity, DiagnosticSeverity.Error);
    assert.ok(d!.message.includes('unknown'));
  });

  it('does not report unknown-arg when sig has a variadic param', async () => {
    reflectStub.resolves(sigVariadicParam);
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'x', extra1: 'a', extra2: 'b'));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.ok(!diags.some((d) => d.code === 'unknown-arg'));
  });

  // ─── type mismatch ──────────────────────────────────────────────────────────

  it('reports type-mismatch when int is passed for a string param', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 42));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    const d = diags.find((d) => d.code === 'type-mismatch');
    assert.ok(d, 'expected type-mismatch diagnostic');
    assert.ok(d!.message.includes('int'));
    assert.ok(d!.message.includes('string'));
  });

  it('does not report type-mismatch for null with a nullable param', async () => {
    reflectStub.resolves(sigNullableParam);
    const src = phpW(`$w = workflow(step: sync(new MyJob(), value: null));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.ok(!diags.some((d) => d.code === 'type-mismatch'));
  });

  it('does not report type-mismatch when expected type is mixed', async () => {
    reflectStub.resolves(sigMixedTypeParam);
    const src = phpW(`$w = workflow(step: sync(new MyJob(), anything: 42));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.ok(!diags.some((d) => d.code === 'type-mismatch'));
  });

  // ─── response() references ──────────────────────────────────────────────────

  it('reports undefined-job-reference for response() to a non-existent job', async () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'x'));\n$r = response('nonexistent');`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    const d = diags.find((d) => d.code === 'undefined-job-reference');
    assert.ok(d, 'expected undefined-job-reference diagnostic');
    assert.strictEqual(d!.severity, DiagnosticSeverity.Warning);
    assert.ok(d!.message.includes('nonexistent'));
  });

  it('reports unknown-response-key when key is not in returnKeys', async () => {
    reflectStub.callsFake(async (_php: string, _auto: string, className: string) => {
      if (className === 'StepOneJob') return sigWithReturnKeys; // has returnKeys: { name, age }
      return {
        ok: true as const,
        class: className,
        method: '__invoke',
        params: [{ name: 'data', type: 'string', nullable: false, hasDefault: false, default: null, position: 0, variadic: false, attributes: [] }],
        returnType: 'void',
      };
    });
    const src = phpW(
      `$w = workflow(\n  step1: sync(new StepOneJob()),\n  step2: sync(new StepTwoJob(), data: response('step1', 'badKey'))\n);`
    );
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    const d = diags.find((d) => d.code === 'unknown-response-key');
    assert.ok(d, `expected unknown-response-key, got: ${diags.map((d) => d.code).join(', ')}`);
  });

  // ─── reflection failure ─────────────────────────────────────────────────────

  it('returns no diagnostics when reflection fails (graceful)', async () => {
    reflectStub.resolves({ ok: false, error: 'Class not found' });
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.strictEqual(diags.length, 0);
  });

  // ─── attribute constraint ───────────────────────────────────────────────────

  it('reports attr-constraint-violation when validateAttribute returns ok: false', async () => {
    reflectStub.resolves(sigWithAttr);
    validateStub.resolves({ ok: false, error: 'Value does not match /^[a-z]+$/' });
    const src = phpW(`$w = workflow(step: sync(new MyJob(), email: 'INVALID'));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    const d = diags.find((d) => d.code === 'attr-constraint-violation');
    assert.ok(d, 'expected attr-constraint-violation diagnostic');
    assert.strictEqual(d!.severity, DiagnosticSeverity.Error);
  });

  it('does not report attr-constraint-violation when validateAttribute returns ok: true', async () => {
    reflectStub.resolves(sigWithAttr);
    validateStub.resolves({ ok: true });
    const src = phpW(`$w = workflow(step: sync(new MyJob(), email: 'valid'));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.ok(!diags.some((d) => d.code === 'attr-constraint-violation'));
  });

  // ─── response() return type mismatch ────────────────────────────────────────

  it('reports type-mismatch when response() return type mismatches param type', async () => {
    reflectStub.callsFake(async (_php: string, _auto: string, className: string) => {
      if (className === 'IntJob') {
        return { ok: true as const, class: 'IntJob', method: '__invoke', params: [], returnType: 'int' };
      }
      return {
        ok: true as const,
        class: 'StringJob',
        method: '__invoke',
        params: [{ name: 'name', type: 'string', nullable: false, hasDefault: false, default: null, position: 0, variadic: false, attributes: [] }],
        returnType: 'void',
      };
    });
    const src = phpW(
      `$w = workflow(\n  job1: sync(new IntJob()),\n  job2: sync(new StringJob(), name: response('job1'))\n);`
    );
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    const d = diags.find((d) => d.code === 'type-mismatch');
    assert.ok(d, `expected type-mismatch diagnostic, got: ${diags.map((d) => d.code).join(', ')}`);
    assert.ok(d!.message.includes('int'), `expected 'int' in message: ${d!.message}`);
    assert.ok(d!.message.includes('string'), `expected 'string' in message: ${d!.message}`);
  });

  // ─── union / intersection type skips type checking ──────────────────────────

  it('does not report type-mismatch for union type param (too complex to validate statically)', async () => {
    reflectStub.resolves({
      ok: true as const,
      class: 'App\\Jobs\\MyJob',
      method: '__invoke',
      params: [{ name: 'value', type: 'string|int', nullable: false, hasDefault: false, default: null, position: 0, variadic: false, attributes: [] }],
      returnType: 'void',
    });
    // bool for string|int — union types are skipped
    const src = phpW(`$w = workflow(step: sync(new MyJob(), value: true));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.ok(!diags.some((d) => d.code === 'type-mismatch'));
  });

  it('does not report type-mismatch for intersection type param', async () => {
    reflectStub.resolves({
      ok: true as const,
      class: 'App\\Jobs\\MyJob',
      method: '__invoke',
      params: [{ name: 'obj', type: 'TypeA&TypeB', nullable: false, hasDefault: false, default: null, position: 0, variadic: false, attributes: [] }],
      returnType: 'void',
    });
    // passing int for intersection type — should be skipped
    const src = phpW(`$w = workflow(step: sync(new MyJob(), obj: 42));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.ok(!diags.some((d) => d.code === 'type-mismatch'));
  });

  // ─── multiple missing args ───────────────────────────────────────────────────

  it('reports a separate diagnostic for each missing required argument', async () => {
    reflectStub.resolves({
      ok: true as const,
      class: 'App\\Jobs\\MyJob',
      method: '__invoke',
      params: [
        { name: 'first', type: 'string', nullable: false, hasDefault: false, default: null, position: 0, variadic: false, attributes: [] },
        { name: 'second', type: 'int', nullable: false, hasDefault: false, default: null, position: 1, variadic: false, attributes: [] },
      ],
      returnType: 'void',
    });
    const src = phpW(`$w = workflow(step: sync(new MyJob()));`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    const missing = diags.filter((d) => d.code === 'missing-required-arg');
    assert.strictEqual(missing.length, 2, `expected 2 missing-required-arg, got ${missing.length}`);
  });

  // ─── valid response() reference ─────────────────────────────────────────────

  it('does not report undefined-job-reference when response() refers to an existing job', async () => {
    const src = phpW(
      `$w = workflow(\n  step: sync(new MyJob(), name: 'x')\n);\n$r = response('step');`
    );
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    assert.ok(!diags.some((d) => d.code === 'undefined-job-reference'));
  });

  // ─── lint violations: new shapes ────────────────────────────────────────────

  // A class-based workflow source so enclosingClass is set
  function phpClass(workflowBody: string): string {
    return `<?php\nnamespace App;\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\nuse function Chevere\\Workflow\\response;\nuse function Chevere\\Workflow\\variable;\nfinal class MyProvider {\n  public static function workflow() {\n    return ${workflowBody};\n  }\n}`;
  }

  it('reports lint-violation for withDepends violation pinned to the missing job name arg', async () => {
    let lintStub: sinon.SinonStub;
    lintStub = sinon.stub(linter, 'lintWorkflowSource').resolves({
      ok: true,
      violations: [{
        job: 'j1',
        method: 'withDepends',
        missing: ['not_found'],
        message: 'Job **j1** has undeclared dependencies: `not_found`',
      }],
      mermaid: '',
    });
    const src = phpClass(`workflow(\n  j1: sync(new \\MyJob())->withDepends('not_found')\n)`);
    const doc = makeDoc(src);
    const diags = await computeDiagnostics(doc, parseDocument(src), CONFIG);
    lintStub.restore();
    const d = diags.find((d) => d.code === 'lint-violation');
    assert.ok(d, 'expected lint-violation for withDepends violation');
    assert.ok(d!.message.includes('undeclared dependencies'));
    // Verify it points to the string arg 'not_found', not the whole job call
    const argOffset = src.indexOf("'not_found'");
    assert.ok(argOffset >= 0, 'source should contain the arg');
    assert.strictEqual(doc.positionAt(argOffset).line, d!.range.start.line, 'diagnostic should be on the withDepends arg line');
  });

  it('reports lint-violation for withRunIf variable violation pinned to the variable() arg', async () => {
    let lintStub: sinon.SinonStub;
    lintStub = sinon.stub(linter, 'lintWorkflowSource').resolves({
      ok: true,
      violations: [{
        job: 'j0',
        method: 'withRunIf',
        variable: 'my_var',
        message: 'Variable **my_var** is not of type `bool|int` at Job **j0**',
      }],
      mermaid: '',
    });
    const src = phpClass(`workflow(\n  j0: sync(new \\MyJob())->withRunIf(variable('my_var'))\n)`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    lintStub.restore();
    const d = diags.find((d) => d.code === 'lint-violation');
    assert.ok(d, 'expected lint-violation for withRunIf variable violation');
    assert.ok(d!.message.includes('my_var'));
  });

  it('reports lint-violation for withRunIfNot response violation pinned to the response() arg', async () => {
    let lintStub: sinon.SinonStub;
    lintStub = sinon.stub(linter, 'lintWorkflowSource').resolves({
      ok: true,
      violations: [{
        job: 'j2',
        method: 'withRunIfNot',
        response: 'j0',
        message: 'Response **j0** must be of type `bool|int`, type `className` provided',
      }],
      mermaid: '',
    });
    const src = phpClass(`workflow(\n  j0: sync(new \\MyJob()),\n  j2: sync(new \\MyJob2())->withRunIfNot(response('j0'))\n)`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    lintStub.restore();
    const d = diags.find((d) => d.code === 'lint-violation');
    assert.ok(d, 'expected lint-violation for withRunIfNot response violation');
    assert.ok(d!.message.includes('bool|int'));
  });

  it('reports lint-violation for withRunIf response->key violation', async () => {
    let lintStub: sinon.SinonStub;
    lintStub = sinon.stub(linter, 'lintWorkflowSource').resolves({
      ok: true,
      violations: [{
        job: 'j2',
        method: 'withRunIf',
        response: 'ja->key',
        message: "Response **ja->key** job `ja` doesn't bind to `key` parameter",
      }],
      mermaid: '',
    });
    const src = phpClass(`workflow(\n  ja: sync(new \\JobA()),\n  j2: sync(new \\MyJob2())->withRunIf(response('ja', 'key'))\n)`);
    const diags = await computeDiagnostics(makeDoc(src), parseDocument(src), CONFIG);
    lintStub.restore();
    const d = diags.find((d) => d.code === 'lint-violation');
    assert.ok(d, 'expected lint-violation for withRunIf response->key violation');
    assert.ok(d!.message.includes("doesn't bind"));
  });
});
