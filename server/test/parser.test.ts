import * as assert from 'assert';
import { parseDocument } from '../src/parser';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Wraps a body in a minimal PHP file that imports workflow/sync/async. */
function php(body: string): string {
  return `<?php\n${body}\n`;
}

/** Wraps body with workflow + sync/async use imports. */
function phpW(body: string): string {
  return php(
    `use function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\nuse function Chevere\\Workflow\\async;\n${body}`
  );
}

// ─── Group 1: empty / non-workflow PHP ───────────────────────────────────────

describe('parseDocument — empty / non-workflow PHP', () => {
  it('returns empty result for a comment-only file', () => {
    const result = parseDocument(php('// just a comment'));
    assert.deepStrictEqual(result.workflowCalls, []);
    assert.deepStrictEqual(result.responseRefs, []);
    assert.strictEqual(result.useMap.size, 0);
  });

  it('returns empty result for an echo statement', () => {
    const result = parseDocument(php('echo "hello";'));
    assert.deepStrictEqual(result.workflowCalls, []);
    assert.deepStrictEqual(result.responseRefs, []);
  });

  it('does not crash on empty string', () => {
    const result = parseDocument('');
    assert.deepStrictEqual(result.workflowCalls, []);
    assert.deepStrictEqual(result.responseRefs, []);
  });

  it('returns the original source on the result', () => {
    const src = php('echo 1;');
    const result = parseDocument(src);
    assert.strictEqual(result.source, src);
  });
});

// ─── Group 2: basic workflow() detection ─────────────────────────────────────

describe('parseDocument — basic workflow() detection', () => {
  it('detects a single sync job', () => {
    const src = phpW(`$w = workflow(\n  step: sync(new MyJob())\n);`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls.length, 1);
    const jobs = result.workflowCalls[0].jobs;
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].name, 'step');
    assert.strictEqual(jobs[0].call.kind, 'sync');
    assert.strictEqual(jobs[0].call.className, 'MyJob');
  });

  it('detects a single async job', () => {
    const src = phpW(`$w = workflow(\n  step: async(MyJob::class)\n);`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls.length, 1);
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.kind, 'async');
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.className, 'MyJob');
  });

  it('detects multiple jobs', () => {
    const src = phpW(`$w = workflow(\n  a: sync(new JobA()),\n  b: sync(new JobB())\n);`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls[0].jobs.length, 2);
    assert.strictEqual(result.workflowCalls[0].jobs[0].name, 'a');
    assert.strictEqual(result.workflowCalls[0].jobs[1].name, 'b');
  });

  it('records callStart and callEnd as valid offsets', () => {
    const src = phpW(`$w = workflow(\n  step: sync(new MyJob())\n);`);
    const result = parseDocument(src);
    const call = result.workflowCalls[0].jobs[0].call;
    assert.ok(call.callStart >= 0);
    assert.ok(call.callEnd > call.callStart);
    assert.ok(call.callEnd <= src.length);
  });

  it('detects fully-qualified \\Chevere\\Workflow\\workflow() call via name resolution', () => {
    // php-parser resolves \Chevere\Workflow\workflow to name node 'Chevere\Workflow\workflow'
    // which matches the isWorkflow check in walkNode
    const src = php(`use function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n$w = workflow(\n  step: sync(new MyJob())\n);`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls.length, 1);
  });
});

// ─── Group 3: use-statement FQCN resolution ──────────────────────────────────

describe('parseDocument — FQCN resolution', () => {
  it('resolves a class via use statement', () => {
    const src = phpW(`use App\\Jobs\\SendEmail;\n$w = workflow(step: sync(new SendEmail()));`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.className, 'App\\Jobs\\SendEmail');
  });

  it('resolves an aliased use statement', () => {
    const src = phpW(`use App\\Jobs\\SendEmail as Mailer;\n$w = workflow(step: sync(new Mailer()));`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.className, 'App\\Jobs\\SendEmail');
  });

  it('qualifies with namespace when no use statement', () => {
    const src = php(
      `namespace App\\Http\\Controllers;\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n$w = workflow(step: sync(new MyJob()));`
    );
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.className, 'App\\Http\\Controllers\\MyJob');
  });

  it('resolves a fully-qualified class name (leading backslash)', () => {
    const src = phpW(`$w = workflow(step: sync(new \\App\\Jobs\\Foo()));`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.className, 'App\\Jobs\\Foo');
  });

  it('resolves ClassName::class via use statement', () => {
    const src = phpW(`use App\\Jobs\\MyJob;\n$w = workflow(step: async(MyJob::class));`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.className, 'App\\Jobs\\MyJob');
  });

  it('stores use map for class imports', () => {
    const src = phpW(`use App\\Jobs\\Foo;\nuse App\\Jobs\\Bar;\n$w = workflow(step: sync(new Foo()));`);
    const result = parseDocument(src);
    assert.strictEqual(result.useMap.get('Foo'), 'App\\Jobs\\Foo');
    assert.strictEqual(result.useMap.get('Bar'), 'App\\Jobs\\Bar');
  });
});

// ─── Group 4: argument parsing ────────────────────────────────────────────────

describe('parseDocument — argument parsing', () => {
  it('parses a string named arg', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), color: 'red'));`);
    const result = parseDocument(src);
    const args = result.workflowCalls[0].jobs[0].call.args;
    assert.strictEqual(args.length, 1);
    assert.strictEqual(args[0].name, 'color');
    assert.strictEqual(args[0].positional, false);
    assert.strictEqual(args[0].resolvedType, 'string');
    assert.strictEqual(args[0].resolvedValue, 'red');
  });

  it('parses an integer named arg', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), count: 42));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.strictEqual(arg.resolvedType, 'int');
    assert.strictEqual(arg.resolvedValue, 42);
  });

  it('parses a negative integer named arg', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), id: -200));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.strictEqual(arg.resolvedType, 'int');
    assert.strictEqual(arg.resolvedValue, -200);
  });

  it('parses a boolean named arg', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), flag: true));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.strictEqual(arg.resolvedType, 'bool');
    assert.strictEqual(arg.resolvedValue, true);
  });

  it('parses a null named arg', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), val: null));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.strictEqual(arg.resolvedType, 'null');
    assert.strictEqual(arg.resolvedValue, null);
  });

  it('returns null resolvedType for variable args', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), val: $someVar));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.strictEqual(arg.resolvedType, null);
    assert.strictEqual(arg.resolvedValue, undefined);
  });

  it('resolves new ClassName() arg to the class type', () => {
    const src = phpW(`use App\\Dto\\Payload;\n$w = workflow(step: sync(new MyJob(), data: new Payload()));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.strictEqual(arg.resolvedType, 'App\\Dto\\Payload');
  });

  it('records valueOffset pointing into source', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), name: 'hello'));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.ok(arg.valueOffset > 0);
    assert.ok(src.slice(arg.valueOffset).startsWith("'hello'"));
  });

  it('marks positional args correctly', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), 'positional'));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.strictEqual(arg.positional, true);
    assert.strictEqual(arg.name, '');
  });
});

// ─── Group 5: response() references ─────────────────────────────────────────

describe('parseDocument — response() references', () => {
  it('detects response() as arg → responseJobRef', () => {
    const src = phpW(`$w = workflow(\n  a: sync(new JobA()),\n  b: sync(new JobB(), src: response('a'))\n);`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[1].call.args[0];
    assert.strictEqual(arg.responseJobRef?.jobName, 'a');
    assert.strictEqual(arg.responseJobRef?.key, undefined);
  });

  it('detects response() with a key', () => {
    const src = phpW(`$w = workflow(\n  a: sync(new JobA()),\n  b: sync(new JobB(), src: response('a', 'name'))\n);`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[1].call.args[0];
    assert.deepStrictEqual(arg.responseJobRef, { jobName: 'a', key: 'name' });
  });

  it('collects standalone response() refs into responseRefs', () => {
    const src = phpW(`$x = response('myJob');`);
    const result = parseDocument(src);
    assert.strictEqual(result.responseRefs.length, 1);
    assert.strictEqual(result.responseRefs[0].jobName, 'myJob');
    assert.ok(result.responseRefs[0].offset >= 0);
  });

  it('returns no responseJobRef for non-response call args', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob(), val: someHelper()));`);
    const result = parseDocument(src);
    const arg = result.workflowCalls[0].jobs[0].call.args[0];
    assert.strictEqual(arg.responseJobRef, undefined);
  });
});

// ─── Group 6: array callable forms ───────────────────────────────────────────

describe('parseDocument — array callables', () => {
  it('resolves [ClassName::class, "method"]', () => {
    const src = phpW(`use App\\Jobs\\Foo;\n$w = workflow(step: sync([Foo::class, 'run']));`);
    const result = parseDocument(src);
    const call = result.workflowCalls[0].jobs[0].call;
    assert.strictEqual(call.className, 'App\\Jobs\\Foo');
    assert.strictEqual(call.methodName, 'run');
  });

  it('resolves ["FQCN", "method"] string array callable', () => {
    const src = phpW(`$w = workflow(step: sync(['App\\\\Jobs\\\\Foo', 'run']));`);
    const result = parseDocument(src);
    const call = result.workflowCalls[0].jobs[0].call;
    assert.strictEqual(call.className, 'App\\Jobs\\Foo');
    assert.strictEqual(call.methodName, 'run');
  });

  it('resolves [$this, "method"] to enclosing class FQCN', () => {
    const src = php(
      `namespace App\\Controllers;\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n\nclass MyController {\n  public static function workflow() {\n    return workflow(step: sync([$this, 'handle']));\n  }\n}`
    );
    const result = parseDocument(src);
    const call = result.workflowCalls[0].jobs[0].call;
    assert.strictEqual(call.className, 'App\\Controllers\\MyController');
    assert.strictEqual(call.methodName, 'handle');
  });
});

// ─── Group 7: inline closures / arrow functions ───────────────────────────────

describe('parseDocument — inline closures', () => {
  it('detects arrow function job, sets className to <closure>', () => {
    const src = phpW(`$w = workflow(step: sync(fn(string $name): void => null, name: 'foo'));`);
    const result = parseDocument(src);
    const call = result.workflowCalls[0].jobs[0].call;
    assert.strictEqual(call.className, '<closure>');
    assert.ok(call.closureSignature !== undefined);
  });

  it('closure signature has correct param name and type', () => {
    const src = phpW(`$w = workflow(step: sync(fn(string $name): void => null));`);
    const result = parseDocument(src);
    const sig = result.workflowCalls[0].jobs[0].call.closureSignature!;
    assert.strictEqual(sig.params.length, 1);
    assert.strictEqual(sig.params[0].name, 'name');
    assert.strictEqual(sig.params[0].type, 'string');
  });

  it('closure signature captures nullable type', () => {
    const src = phpW(`$w = workflow(step: sync(fn(?string $val): void => null));`);
    const result = parseDocument(src);
    const param = result.workflowCalls[0].jobs[0].call.closureSignature!.params[0];
    assert.strictEqual(param.nullable, true);
  });

  it('closure signature captures return type', () => {
    const src = phpW(`$w = workflow(step: sync(fn(int $n): string => 'x'));`);
    const result = parseDocument(src);
    const sig = result.workflowCalls[0].jobs[0].call.closureSignature!;
    assert.strictEqual(sig.returnType, 'string');
  });

  it('closure signature captures default param value', () => {
    const src = phpW(`$w = workflow(step: sync(fn(string $x = 'default'): void => null));`);
    const result = parseDocument(src);
    const param = result.workflowCalls[0].jobs[0].call.closureSignature!.params[0];
    assert.strictEqual(param.hasDefault, true);
  });
});

// ─── Group 8: workflowClassName detection ────────────────────────────────────

describe('parseDocument — workflowClassName detection', () => {
  it('detects a class with a static workflow() method', () => {
    const src = php(
      `namespace App;\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n\nclass MyWorkflow {\n  public static function workflow() {\n    return workflow(step: sync(new SomeJob()));\n  }\n}`
    );
    const result = parseDocument(src);
    assert.strictEqual(result.workflowClassName, 'App\\MyWorkflow');
  });

  it('returns undefined when no static workflow() method exists', () => {
    const src = phpW(`class MyClass { public function run() {} }`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowClassName, undefined);
  });
});

// ─── Group 9: method chain unwrapping ────────────────────────────────────────

describe('parseDocument — method chain unwrapping', () => {
  it('still detects className when ->withRunIf() is chained', () => {
    const src = phpW(`$w = workflow(step: sync(new MyJob())->withRunIf(fn() => true));`);
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.className, 'MyJob');
  });
});

// ─── Group 10: use function alias for workflow ────────────────────────────────

describe('parseDocument — use function alias', () => {
  it('detects workflow() called under an alias', () => {
    const src = php(
      `use function Chevere\\Workflow\\workflow as wf;\nuse function Chevere\\Workflow\\sync;\n$w = wf(step: sync(new MyJob()));`
    );
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls.length, 1);
    assert.strictEqual(result.workflowCalls[0].jobs[0].call.className, 'MyJob');
  });
});

// ─── Group 11: multiple workflow calls ───────────────────────────────────────

describe('parseDocument — multiple workflow calls', () => {
  it('detects two separate workflow() calls in one file', () => {
    const src = phpW(
      `$w1 = workflow(step: sync(new JobA()));\n$w2 = workflow(step: sync(new JobB()));`
    );
    const result = parseDocument(src);
    assert.strictEqual(result.workflowCalls.length, 2);
  });
});
