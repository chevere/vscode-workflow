import * as assert from 'assert';
import { buildJobGraphHtml, buildPhpWrapper, graphHtml, sanitizeWorkflowExpr, protectFnSignatures } from '../src/jobGraph';
import { parseDocument } from '../src/parser';
import { ParsedDocument } from '../src/parser';

// ─── sanitizeWorkflowExpr ─────────────────────────────────────────────────────

describe('sanitizeWorkflowExpr — variable replacement', () => {
  it('replaces a plain variable with empty string', () => {
    assert.strictEqual(sanitizeWorkflowExpr('$var'), "''");
  });

  it('replaces array-keyed variable', () => {
    assert.strictEqual(sanitizeWorkflowExpr("$arr['key']"), "''");
  });

  it('replaces numerically-indexed variable', () => {
    assert.strictEqual(sanitizeWorkflowExpr('$arr[0]'), "''");
  });

  it('replaces multiple variables independently', () => {
    const result = sanitizeWorkflowExpr("sync(new Job(), name: $name, count: $count)");
    assert.ok(!result.includes('$name'));
    assert.ok(!result.includes('$count'));
  });
});

describe('sanitizeWorkflowExpr — null coalescing fallback', () => {
  it('preserves null fallback', () => {
    assert.strictEqual(sanitizeWorkflowExpr('$var ?? null'), 'null');
  });

  it('preserves string fallback', () => {
    assert.strictEqual(sanitizeWorkflowExpr("$var ?? 'default'"), "'default'");
  });

  it('preserves integer fallback', () => {
    assert.strictEqual(sanitizeWorkflowExpr('$count ?? 0'), '0');
  });

  it('preserves array-keyed variable with fallback', () => {
    assert.strictEqual(sanitizeWorkflowExpr("$arr['key'] ?? null"), 'null');
  });
});

describe('sanitizeWorkflowExpr — $this in array callable', () => {
  it('replaces [$this, method] with enclosing FQCN string', () => {
    const result = sanitizeWorkflowExpr("[$this, 'handle']", 'App\\Jobs\\Foo');
    assert.strictEqual(result, "'App\\\\Jobs\\\\Foo'");
  });

  it('replaces [$this, method] without enclosingFqcn using variable replacement', () => {
    // Without enclosingFqcn, $this is replaced by the generic variable regex
    const result = sanitizeWorkflowExpr("[$this, 'handle']");
    assert.ok(!result.includes('$this'));
  });
});

describe('sanitizeWorkflowExpr — closure parameter protection', () => {
  it('preserves $name inside fn() parameter list', () => {
    const result = sanitizeWorkflowExpr('fn(string $name) => $name');
    // $name inside fn(...) params should be preserved
    assert.ok(result.includes('string $name'), `got: ${result}`);
  });

  it('replaces $outside but not $inside fn() params', () => {
    const result = sanitizeWorkflowExpr('fn(string $inside) => $outside');
    assert.ok(!result.includes('$outside'), `$outside should be replaced, got: ${result}`);
    assert.ok(result.includes('$inside'), `$inside in params should be preserved, got: ${result}`);
  });

  it('handles nested parentheses in attributes inside fn() params', () => {
    const result = sanitizeWorkflowExpr("fn(#[_string('/re(x)/')] string $s) => $s");
    // $s in param list should be preserved
    assert.ok(result.includes('string $s'), `expected $s preserved in params, got: ${result}`);
  });

  it('preserves function() keyword form', () => {
    const result = sanitizeWorkflowExpr('function(int $x) { return $x; }');
    assert.ok(result.includes('int $x'), `got: ${result}`);
  });
});

describe('sanitizeWorkflowExpr — double-quoted string interpolations', () => {
  it('removes {$var} interpolations from double-quoted strings', () => {
    const result = sanitizeWorkflowExpr('"hello {$world}"');
    assert.ok(!result.includes('{$world}'), `got: ${result}`);
    assert.ok(!result.includes('$world'), `got: ${result}`);
  });
});

// ─── protectFnSignatures ──────────────────────────────────────────────────────

describe('protectFnSignatures — keyword detection', () => {
  it('replaces fn(...) with a placeholder', () => {
    const sigs: string[] = [];
    const result = protectFnSignatures('fn(int $x)', sigs);
    assert.ok(result.includes('__FNPARAMS_0__'));
    assert.strictEqual(sigs.length, 1);
    assert.ok(sigs[0].includes('int $x'));
  });

  it('replaces function(...) with a placeholder', () => {
    const sigs: string[] = [];
    const result = protectFnSignatures('function(string $s)', sigs);
    assert.ok(result.includes('__FNPARAMS_0__'));
    assert.strictEqual(sigs.length, 1);
  });

  it('does NOT replace myfn(...) — word boundary respected', () => {
    const sigs: string[] = [];
    const result = protectFnSignatures('myfn(int $x)', sigs);
    assert.strictEqual(sigs.length, 0);
    assert.ok(!result.includes('__FNPARAMS_'));
  });

  it('handles two closures, producing two placeholders', () => {
    const sigs: string[] = [];
    const result = protectFnSignatures('fn(string $a) fn(int $b)', sigs);
    assert.strictEqual(sigs.length, 2);
    assert.ok(result.includes('__FNPARAMS_0__'));
    assert.ok(result.includes('__FNPARAMS_1__'));
  });

  it('round-trips: placeholder is replaced back to original by sanitizeWorkflowExpr', () => {
    // sanitizeWorkflowExpr calls protectFnSignatures internally and restores placeholders
    const input = 'fn(string $name) => $name';
    const result = sanitizeWorkflowExpr(input);
    // The fn(...) part should be restored intact
    assert.ok(result.includes('fn(string $name)'), `got: ${result}`);
  });
});

// ─── sanitizeWorkflowExpr — additional edge cases ─────────────────────────────

describe('sanitizeWorkflowExpr — additional edge cases', () => {
  it('replaces deeply nested array-keyed variable', () => {
    const result = sanitizeWorkflowExpr("$arr['a']['b']");
    assert.ok(!result.includes('$arr'), `$arr should be replaced, got: ${result}`);
    assert.strictEqual(result, "''");
  });

  it('preserves float fallback value in null coalescing', () => {
    const result = sanitizeWorkflowExpr('$var ?? 1.5');
    assert.strictEqual(result, '1.5');
  });

  it('does not alter a plain string literal with no variables', () => {
    const result = sanitizeWorkflowExpr("'hello world'");
    assert.strictEqual(result, "'hello world'");
  });

  it('handles empty string expression without error', () => {
    assert.doesNotThrow(() => sanitizeWorkflowExpr(''));
  });
});

// ─── graphHtml — export buttons ──────────────────────────────────────────────

describe('graphHtml — export buttons', () => {
  const html = graphHtml('graph TB\n  A --> B', 'file:///foo.php', 1);

  it('includes SVG export button', () => {
    assert.ok(html.includes('id="btn-export-svg"'), 'expected btn-export-svg button');
  });

  it('includes PNG export button', () => {
    assert.ok(html.includes('id="btn-export-png"'), 'expected btn-export-png button');
  });

  it('PNG export uses data: URI, not blob: URL', () => {
    assert.ok(html.includes('data:image/svg+xml;base64,'), 'expected data: URI approach for PNG canvas rendering');
    assert.ok(!html.includes('URL.createObjectURL'), 'must not use createObjectURL (unreliable in WebViews)');
  });

  it('getSvgString clones SVG with transparent background and uses XMLSerializer', () => {
    assert.ok(html.includes('getSvgString'), 'expected getSvgString helper in HTML');
    assert.ok(html.includes("'transparent'"), 'expected transparent background set on clone');
    assert.ok(html.includes('XMLSerializer'), 'expected XMLSerializer used for SVG serialization');
  });

  it('postMessage commands are exportSvg and exportPng', () => {
    assert.ok(html.includes("command: 'exportSvg'"), 'expected exportSvg postMessage command');
    assert.ok(html.includes("command: 'exportPng'"), 'expected exportPng postMessage command');
  });

  it('PNG export includes onerror svgFallback handler', () => {
    assert.ok(html.includes('svgFallback'), 'expected svgFallback in onerror handler for PNG');
  });

  it('PNG export scales canvas at 2x for higher resolution', () => {
    assert.ok(html.includes('dpr'), 'expected device pixel ratio scaling in PNG export');
    assert.ok(html.includes('ctx.scale'), 'expected ctx.scale call for 2x output');
  });
});

// ─── graphHtml — CSP nonce ────────────────────────────────────────────────────

describe('graphHtml — CSP nonce', () => {
  it('does not contain unsafe-inline in script-src when cspSource is provided', () => {
    const html = graphHtml('graph TB\n  A --> B', 'file:///foo.php', 1, undefined, 'vscode-resource:/mermaid.js', undefined, 'vscode-webview:');
    const cspMatch = html.match(/Content-Security-Policy[^>]*content="([^"]+)"/);
    assert.ok(cspMatch, 'expected CSP meta tag');
    const csp = cspMatch![1];
    assert.ok(!csp.includes("'unsafe-inline'") || !csp.split(';').find(d => d.trim().startsWith('script-src'))?.includes("'unsafe-inline'"), 'script-src must not use unsafe-inline');
    assert.ok(csp.includes("'nonce-"), 'script-src must use a nonce');
  });

  it('applies the same nonce to both script tags', () => {
    const html = graphHtml('graph TB\n  A --> B', 'file:///foo.php', 1, undefined, 'vscode-resource:/mermaid.js', undefined, 'vscode-webview:');
    const nonceMatch = html.match(/nonce="([^"]+)"/g);
    assert.ok(nonceMatch && nonceMatch.length >= 2, 'expected nonce on both script tags');
    const values = nonceMatch!.map(m => m.replace(/nonce="|"/g, ''));
    assert.strictEqual(values[0], values[1], 'both script tags must share the same nonce');
  });

  it('generates a different nonce on each call', () => {
    const html1 = graphHtml('graph TB\n  A --> B', 'file:///foo.php', 1, undefined, undefined, undefined, 'vscode-webview:');
    const html2 = graphHtml('graph TB\n  A --> B', 'file:///foo.php', 1, undefined, undefined, undefined, 'vscode-webview:');
    const nonce1 = html1.match(/nonce="([^"]+)"/)?.[1];
    const nonce2 = html2.match(/nonce="([^"]+)"/)?.[1];
    assert.ok(nonce1 && nonce2 && nonce1 !== nonce2, 'each render must produce a unique nonce');
  });
});

// ─── buildPhpWrapper — namespace injection guard ──────────────────────────────

describe('buildPhpWrapper — namespace injection guard', () => {
  const AUTOLOAD = '/project/vendor/autoload.php';
  const EXPR = "workflow(new JobA())";

  it('rejects a namespace containing a semicolon (code injection)', () => {
    const php = buildPhpWrapper(AUTOLOAD, "Foo; system('id'); //", [], EXPR);
    assert.ok(!php.includes("system('id')"), `injection must not appear in output:\n${php}`);
  });

  it('rejects a namespace with an embedded newline', () => {
    const php = buildPhpWrapper(AUTOLOAD, "Foo\necho 'injected';", [], EXPR);
    assert.ok(!php.includes("echo 'injected'"), `injection must not appear in output:\n${php}`);
  });

  it('rejects a namespace with a trailing backslash (regex edge case)', () => {
    const php = buildPhpWrapper(AUTOLOAD, 'Foo\\', [], EXPR);
    assert.ok(!php.includes('namespace Foo\\'), `trailing-backslash namespace must not appear in output:\n${php}`);
  });

  it('accepts a valid simple namespace', () => {
    const php = buildPhpWrapper(AUTOLOAD, 'App\\Jobs', [], EXPR);
    assert.ok(php.includes('namespace App\\Jobs;'), `valid namespace must appear in output:\n${php}`);
  });
});

// ─── buildJobGraphHtml — pure error paths (no PHP subprocess required) ────────

describe('buildJobGraphHtml — error HTML paths', () => {
  const GRAPH_CONFIG = { phpExecutable: 'php', autoloaderPath: '/autoload.php' };

  it('returns error HTML containing "No workflow found" when parsed document is empty', async () => {
    const emptyParsed: ParsedDocument = {
      workflowCalls: [],
      responseRefs: [],
      useMap: new Map(),
      source: '',
    };
    const html = await buildJobGraphHtml(emptyParsed, GRAPH_CONFIG);
    assert.ok(html.includes('<!DOCTYPE html'), 'expected valid HTML document');
    assert.ok(html.toLowerCase().includes('no workflow'), `expected "No workflow" in output, got snippet: ${html.slice(0, 300)}`);
  });

  it('returns error HTML about autoload when autoloaderPath is empty and workflowClassName is set', async () => {
    const parsed: ParsedDocument = {
      workflowCalls: [],
      responseRefs: [],
      useMap: new Map(),
      workflowClassName: 'App\\MyWorkflow',
      source: '',
    };
    const html = await buildJobGraphHtml(parsed, { phpExecutable: 'php', autoloaderPath: '' });
    assert.ok(html.includes('<!DOCTYPE html'), 'expected valid HTML document');
    assert.ok(html.includes('vendor/autoload.php'), `expected autoload mention, got snippet: ${html.slice(0, 300)}`);
  });

  it('returns error HTML about autoload when autoloaderPath is empty and there are workflow calls', async () => {
    const src = `<?php\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n$w = workflow(step: sync(new MyJob()));\n`;
    const parsed = parseDocument(src);
    const html = await buildJobGraphHtml(parsed, { phpExecutable: 'php', autoloaderPath: '' });
    assert.ok(html.includes('<!DOCTYPE html'), 'expected valid HTML document');
    assert.ok(html.includes('vendor/autoload.php'), `expected autoload mention, got snippet: ${html.slice(0, 300)}`);
  });
});
