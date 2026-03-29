import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ParsedDocument, WorkflowCall } from './parser';
import { sanitizePhpExecutable } from './phpExecutable';
import { lintWorkflow } from './linter';
import { getTempDir } from './tempDir';

export interface GraphConfig {
  phpExecutable: string;
  autoloaderPath: string;
  homepageUrl?: string;
  mermaidScriptUri?: string;
  codiconCssUri?: string;
  cspSource?: string;
}

/**
 * Replace runtime PHP variable expressions inside a workflow() call with safe
 * placeholder literals so the snippet can execute in an isolated script.
 * Only the workflow structure (job names / classes) matters for graph output;
 * actual argument values are irrelevant.
 *
 * Handles: $var  $var['key']  $var['a']['b']  $var ?? null  $var['k'] ?? null
 * Also handles array callables: [$this, 'method'] → enclosing class FQCN string
 */
export function sanitizeWorkflowExpr(expr: string, enclosingFqcn?: string): string {
  let result = expr;
  // Replace [$this, 'method'] / [$this, "method"] with the enclosing class FQCN string
  // before the generic variable replacement strips $this to ''
  if (enclosingFqcn) {
    const fqcnLiteral = `'${enclosingFqcn.replace(/\\/g, '\\\\')}'`;
    result = result.replace(/\[\s*\$this\s*,\s*(?:'[^']*'|"[^"]*")\s*\]/g, fqcnLiteral);
  }
  // Remove {$var} interpolations inside double-quoted strings; replacing with '' would
  // produce {"''} which is invalid PHP syntax.
  result = result.replace(/\{\$\w+(?:\[(?:'[^']*'|"[^"]*"|\d+|\w+)\])*\}/g, '');
  // Protect function/closure signatures so parameter names ($var) are not replaced.
  // Use balanced-parenthesis matching instead of [^)]* to handle nested parens in
  // attributes like #[_string('/regex(with)parens/')] inside parameter lists.
  const fnSigs: string[] = [];
  result = protectFnSignatures(result, fnSigs);
  result = result.replace(
    /\$\w+(?:\[(?:'[^']*'|"[^"]*"|\d+|\w+)\])*(?:\s*\?\?\s*(null|'[^']*'|"[^"]*"|\d+(?:\.\d+)?))?/g,
    (_match, fallback?: string) => fallback !== undefined ? fallback : "''"
  );
  return result.replace(/__FNPARAMS_(\d+)__/g, (_, i) => fnSigs[parseInt(i)]);
}

/**
 * Walk `text` character-by-character, finding `fn(` / `function(` keywords and
 * replacing their parameter lists (including nested parentheses) with placeholders.
 * This handles attribute patterns like #[_string('/regex(?=with)parens/')] inside
 * parameter lists, which the simple [^)]* regex cannot handle.
 */
export function protectFnSignatures(text: string, sigs: string[]): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    // Only try to match 'fn'/'function' at a non-word boundary
    if (i > 0 && /\w/.test(text[i - 1])) {
      out += text[i++];
      continue;
    }

    let keyword: string | null = null;
    if (text.startsWith('function', i)) {
      keyword = 'function';
    } else if (
      text.startsWith('fn', i) &&
      (i + 2 >= text.length || !/\w/.test(text[i + 2]))
    ) {
      keyword = 'fn';
    }

    if (keyword) {
      let j = i + keyword.length;
      // Skip optional whitespace between keyword and '('
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && text[j] === '(') {
        // Balanced-paren scan to find the closing ')'
        let depth = 1;
        j++;
        while (j < text.length && depth > 0) {
          if (text[j] === '(') depth++;
          else if (text[j] === ')') depth--;
          j++;
        }
        const sig = text.slice(i, j);
        sigs.push(sig);
        out += `__FNPARAMS_${sigs.length - 1}__`;
        i = j;
        continue;
      }
    }

    out += text[i++];
  }

  return out;
}

export function buildPhpWrapper(
  autoloaderPath: string,
  namespace: string,
  useLines: string[],
  workflowExpr: string,
): string {
  const lines = ['<?php', 'declare(strict_types=1);'];
  const SAFE_NAMESPACE = /^[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*$/;
  if (namespace && SAFE_NAMESPACE.test(namespace)) lines.push(`namespace ${namespace};`);
  lines.push(`require ${JSON.stringify(autoloaderPath)};`);
  const SAFE_USE = /^use\s+\\?[A-Za-z_][A-Za-z0-9_\\]*(\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?;$/;
  for (const line of useLines) {
    if (SAFE_USE.test(line)) lines.push(line);
  }
  lines.push(`$workflow = ${workflowExpr};`);
  lines.push(`$mermaid = \\Chevere\\Workflow\\Mermaid::generate($workflow);`);
  lines.push(`echo json_encode(['ok' => true, 'mermaid' => $mermaid]);`);
  return lines.join('\n') + '\n';
}

function runPhpWrapper(
  phpExecutable: string,
  phpContent: string,
): Promise<{ ok: true; mermaid: string } | { ok: false; error: string }> {
  const tmpFile = path.join(getTempDir(), 'mermaid_wrapper.php');
  fs.writeFileSync(tmpFile, phpContent);
  return new Promise((resolve) => {
    execFile(
      sanitizePhpExecutable(phpExecutable),
      [tmpFile],
      { timeout: 10000, env: { ...process.env, CHEVERE_WORKFLOW_LINT_ENABLE: '1' } },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch { }
        if (err && !stdout) {
          resolve({ ok: false, error: stderr || err.message });
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve({ ok: false, error: `Failed to parse script output: ${stdout}` });
        }
      }
    );
  });
}

function pickWorkflowCall(calls: WorkflowCall[], cursorOffset?: number): WorkflowCall {
  if (calls.length === 1 || cursorOffset === undefined) return calls[0];
  // Prefer a call that contains the cursor, then the last one that starts before it
  const containing = calls.find(wc => cursorOffset >= wc.callStart && cursorOffset <= wc.callEnd);
  if (containing) return containing;
  let best = calls[0];
  for (const wc of calls) {
    if (wc.callStart <= cursorOffset && wc.callStart > best.callStart) best = wc;
  }
  return best;
}

export async function buildJobGraphHtml(
  parsed: ParsedDocument,
  config: GraphConfig,
  sourceUri: string,
  cursorOffset?: number
): Promise<string> {
  // Prefer the lint path for classes with a static workflow() method — it tolerates
  // literal-value violations and still produces a Mermaid graph.
  if (parsed.workflowClassName) {
    if (!config.autoloaderPath) {
      return errorHtml('No <code>vendor/autoload.php</code> found. Configure <code>chevereWorkflow.composerJsonPath</code> if needed.');
    }
    const result = await lintWorkflow(
      config.phpExecutable,
      config.autoloaderPath,
      parsed.workflowClassName
    );
    if (!result.ok) {
      const detail = result.error.length > 500 ? result.error.slice(0, 500) + '…' : result.error;
      return errorHtml('Failed to generate graph.', escapeHtml(detail));
    }
    const sourceLine = cursorOffset !== undefined ? lineFromOffset(parsed.source, cursorOffset) : 1;
    const exportBaseName = parsed.workflowClassName?.split('\\').pop();
    return graphHtml(result.mermaid, sourceUri, sourceLine, config.homepageUrl, config.mermaidScriptUri, config.codiconCssUri, config.cspSource, exportBaseName);
  }

  // Fallback: extract the real workflow() expression from source and execute it via PHP
  if (parsed.workflowCalls.length > 0) {
    if (!config.autoloaderPath) {
      return errorHtml('No <code>vendor/autoload.php</code> found. Configure <code>chevereWorkflow.composerJsonPath</code> if needed.');
    }
    const source = parsed.source;
    const namespace = parsed.useMap.get('__namespace__') ?? '';
    const useLines = [...parsed.useMap.entries()]
      .filter(([alias]) => alias !== '__namespace__')
      .map(([alias, fqcn]) =>
        alias === fqcn.split('\\').pop()
          ? `use ${fqcn};`
          : `use ${fqcn} as ${alias};`
      );
    // Pick the closest workflow() call at or before the cursor; fall back to the first one
    const wc = pickWorkflowCall(parsed.workflowCalls, cursorOffset);
    const sourceLine = lineFromOffset(source, wc.callStart);
    const workflowExpr = sanitizeWorkflowExpr(source.slice(wc.callStart, wc.callEnd), wc.enclosingClass);
    const phpContent = buildPhpWrapper(config.autoloaderPath, namespace, useLines, workflowExpr);
    const result = await runPhpWrapper(config.phpExecutable, phpContent);
    if (!result.ok) {
      const detail = result.error.length > 500 ? result.error.slice(0, 500) + '…' : result.error;
      return errorHtml('Failed to generate graph.', escapeHtml(detail));
    }
    return graphHtml(result.mermaid, sourceUri, sourceLine, config.homepageUrl, config.mermaidScriptUri, config.codiconCssUri, config.cspSource);
  }

  return errorHtml('No workflow found. Make sure the active file contains a <code>workflow()</code> call.');
}

function lineFromOffset(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param message Trusted HTML string — rendered verbatim. Do NOT pass user-derived content.
 * @param detail Plain text — HTML-escaped before rendering.
 */
export function errorHtml(message: string, detail?: string): string {
  const detailBlock = detail
    ? `\n<pre class="detail"><code>${detail}</code></pre>`
    : '';
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 24px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
           font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 13px; }
    .title { color: var(--vscode-errorForeground); font-weight: 600; margin-bottom: 12px; }
    pre.detail { margin: 0; padding: 12px 16px; border-radius: 4px;
                 background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.1));
                 border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
                 color: var(--vscode-errorForeground); white-space: pre-wrap; word-break: break-all; font-size: 12px; }
  </style>
</head>
<body><p class="title">${message}</p>${detailBlock}</body>
</html>`;
}

export function graphHtml(mermaid: string, sourceUri: string, sourceLine: number, homepageUrl?: string, mermaidScriptUri?: string, codiconCssUri?: string, cspSource?: string, exportBaseName?: string): string {
  // Safely embed the mermaid source as a JS string
  const jsLiteral = JSON.stringify(mermaid);
  const uriLiteral = JSON.stringify(sourceUri);
  const homepageLiteral = JSON.stringify(homepageUrl ?? null);
  const exportBaseNameLiteral = JSON.stringify(exportBaseName ?? null);
  const fileName = sourceUri.split('/').pop() ?? sourceUri;
  const nonce = randomBytes(16).toString('base64');
  const mermaidSrc = mermaidScriptUri ?? '';
  const codiconLink = codiconCssUri ? `\n  <link rel="stylesheet" href="${codiconCssUri}">` : '';
  const cspTag = cspSource
    ? `\n  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; img-src data: blob:;">`
    : '';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">${cspTag}${codiconLink}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-editor-font-family, ui-monospace, monospace); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

    /* ── Tabs ── */
    .tabs { display: flex; align-items: center; gap: 0; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border, var(--vscode-editorWidget-border))); flex-shrink: 0; }
    .tab { padding: 8px 20px; font-size: 12px; cursor: pointer; color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground)); border-bottom: 2px solid transparent; background: none; border-top: none; border-left: none; border-right: none; }
    .tab:hover { color: var(--vscode-tab-activeForeground, var(--vscode-editor-foreground)); }
    .tab.active { color: var(--vscode-tab-activeForeground, var(--vscode-editor-foreground)); border-bottom-color: var(--vscode-focusBorder); }
    .tabs-spacer { flex: 1; }
    .tabs-logo { display: flex; align-items: center; padding: 0; border: none; outline: none; border-radius: 4px; background: transparent; cursor: pointer; transition: background 0.1s; }
    .tabs-logo:hover { background: var(--vscode-toolbar-hoverBackground); }
    .tabs-logo:focus-visible { outline: 1px solid var(--vscode-focusBorder); }

    /* ── Toolbar ── */
    .toolbar { display: flex; align-items: center; gap: 0; padding: 0 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border, var(--vscode-editorWidget-border))); flex-shrink: 0; height: 28px; }
    .toolbar button { background: transparent; border: none; color: var(--vscode-icon-foreground, var(--vscode-editor-foreground)); border-radius: 0; padding: 0; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
    .toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .toolbar button:active { background: var(--vscode-toolbar-activeBackground); }
    .toolbar button.text-btn { width: auto; padding: 2px 6px; font-size: 11px; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-descriptionForeground); }
    .toolbar button.text-btn:hover { color: var(--vscode-editor-foreground); }
    .toolbar-sep { width: 1px; height: 16px; background: var(--vscode-panel-border, var(--vscode-editorGroup-border)); margin: 0 4px; flex-shrink: 0; }
    .zoom-label { font-size: 11px; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-descriptionForeground); min-width: 38px; text-align: center; }

    /* ── Panels ── */
    .panel { flex: 1; overflow: hidden; display: none; }
    .panel.active { display: flex; }

    /* ── Graph panel ── */
    #graph-panel { position: relative; }
    #graph-viewport { width: 100%; height: 100%; overflow: hidden; cursor: grab; }
    #graph-viewport:active { cursor: grabbing; }
    #graph-canvas { transform-origin: 0 0; display: inline-block; }
    #graph-canvas .mermaid svg { display: block; }

    /* ── Code panel ── */
    #code-panel { flex-direction: column; }
    #code-toolbar { display: none; align-items: center; justify-content: flex-end; gap: 0; padding: 2px 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border, var(--vscode-editorWidget-border))); flex-shrink: 0; height: 28px; }
    #code-toolbar button { background: transparent; border: none; color: var(--vscode-icon-foreground, var(--vscode-editor-foreground)); border-radius: 0; padding: 0; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
    #code-toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
    #code-toolbar button:active { background: var(--vscode-toolbar-activeBackground); }
    #code-panel pre { margin: 0; padding: 24px; overflow: auto; flex: 1; font-size: 13px; line-height: 1.6; color: var(--vscode-editor-foreground); white-space: pre; tab-size: 2; }

    /* ── Active job node highlight ── */
    #diagram .node.current-node > rect,
    #diagram .node.current-node > polygon,
    #diagram .node.current-node > circle,
    #diagram .node.current-node > ellipse {
      stroke: var(--vscode-focusBorder) !important;
      stroke-width: 3px !important;
      fill: var(--vscode-editor-selectionBackground) !important;
    }

    /* ── Mermaid syntax highlighting ── */
    .mh-kw    { color: var(--vscode-symbolIcon-keywordForeground,  #569cd6); }
    .mh-id    { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }
    .mh-op    { color: var(--vscode-editor-foreground); opacity: 0.55; }
    .mh-label { color: var(--vscode-symbolIcon-stringForeground,   #ce9178); }
  </style>
</head>
<body>

<div class="tabs">
  <button class="tab active" data-tab="graph">Graph</button>
  <button class="tab" data-tab="code">Mermaid</button>
  <span class="tabs-spacer"></span>
  <button class="tabs-logo" id="btn-homepage" title="Chevere Workflow">
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 395.5 395.5" aria-hidden="true">
      <path d="M55.8,0H341.1a55.1,55.1,0,0,1,55.1,55.1V340.4a55.1,55.1,0,0,1-55.1,55.1H55.8a55.1,55.1,0,0,1-55-55.1V55.1A55.1,55.1,0,0,1,55.8,0Z" transform="translate(-0.8)" fill="transparent"/>
      <path d="M63,198.5v-.7c0-66.1,49.4-120.9,118.2-120.9,37.9,0,61.9,12.3,83.6,30.4a14.2,14.2,0,0,1,5.3,10.7c0,7-6.3,13-13.3,13a15.7,15.7,0,0,1-8.7-3c-18-16.1-38.5-26.7-67.1-26.7-51.8,0-90.5,42-90.5,95.8v.7c0,54.1,39.1,96.5,90.5,96.5,29.1,0,49.4-10,69.5-28.4a12.4,12.4,0,0,1,8.3-3.6c6.7,0,12.7,6,12.7,12.6a12.6,12.6,0,0,1-4.3,9.4c-23.1,21-48.4,34.4-86.9,34.4C112.8,318.7,63,265.6,63,198.5Z" transform="translate(-0.8)" fill="var(--vscode-tab-inactiveForeground)"/>
      <path d="M318.9,77.7a13.6,13.6,0,0,0-11.3,13.4v82.2A13.6,13.6,0,0,1,294,186.9H214.3a13.7,13.7,0,0,1-10.9-5.4,31.6,31.6,0,1,0-5.8,44.3,33.2,33.2,0,0,0,6.6-6.9,13.8,13.8,0,0,1,11.2-5.7H294a13.6,13.6,0,0,1,13.6,13.6v77.7a13.5,13.5,0,0,0,11.3,13.4,13.2,13.2,0,0,0,14.9-11.1,12.1,12.1,0,0,0,.1-1.9V90.7a13.1,13.1,0,0,0-13.1-13.1Z" transform="translate(-0.8)" fill="var(--vscode-tab-inactiveForeground)"/>
    </svg>
  </button>
</div>

<div class="toolbar" id="graph-toolbar">
  <button id="btn-zoom-in" title="Zoom in"><i class="codicon codicon-zoom-in"></i></button>
  <span class="zoom-label" id="zoom-label">100%</span>
  <button id="btn-zoom-out" title="Zoom out"><i class="codicon codicon-zoom-out"></i></button>
  <div class="toolbar-sep"></div>
  <button id="btn-reset" title="Reset zoom"><i class="codicon codicon-refresh"></i></button>
  <button id="btn-fit" title="Fit to view"><i class="codicon codicon-screen-full"></i></button>
  <div class="toolbar-sep"></div>
  <button id="btn-export-svg" class="text-btn" title="Export as SVG">SVG</button>
  <button id="btn-export-png" class="text-btn" title="Export as PNG">PNG</button>
  <div class="toolbar-sep"></div>
  <button id="btn-goto-source" class="text-btn" title="Open source file">${escapeHtml(fileName)}:${sourceLine}</button>
</div>

<div class="panel active" id="graph-panel">
  <div id="graph-viewport">
    <div id="graph-canvas">
      <div class="mermaid" id="diagram"></div>
    </div>
  </div>
</div>

<div id="code-toolbar">
  <button id="btn-copy" title="Copy to clipboard">
    <i id="icon-copy" class="codicon codicon-copy"></i>
    <i id="icon-check" class="codicon codicon-check" style="display:none"></i>
  </button>
</div>

<div class="panel" id="code-panel">
  <pre id="code-block"></pre>
</div>

<script nonce="${nonce}" src="${mermaidSrc}"></script>
<script nonce="${nonce}">
(function () {
  const SOURCE = ${jsLiteral};
  const SOURCE_URI = ${uriLiteral};
  const SOURCE_LINE = ${sourceLine};
  const HOMEPAGE_URL = ${homepageLiteral};
  const EXPORT_BASE_NAME = ${exportBaseNameLiteral};
  const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  // ── Tabs ─────────────────────────────────────────────────────────────────
  const toolbar = document.getElementById('graph-toolbar');
  const codeToolbar = document.getElementById('code-toolbar');
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = tab.dataset.tab + '-panel';
      document.getElementById(panelId).classList.add('active');
      const isGraph = tab.dataset.tab === 'graph';
      toolbar.style.display = isGraph ? '' : 'none';
      codeToolbar.style.display = isGraph ? 'none' : 'flex';
    });
  });

  // ── Code tab ─────────────────────────────────────────────────────────────
  function highlightMermaid(code) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const wrap = (cls, s) => '<span class="mh-' + cls + '">' + esc(s) + '</span>';
    return code.split('\\n').map(line => {
      let m;
      // graph TB; / flowchart LR;
      if ((m = line.match(/^(\\s*)(graph|flowchart)(\\s+)(TB|LR|TD|RL|BT)(;?.*)/i)))
        return esc(m[1]) + wrap('kw', m[2]) + esc(m[3]) + wrap('kw', m[4]) + esc(m[5]);
      // edge: id --> |"label"| id
      if ((m = line.match(/^(\\s*)(\\w+)(-->|-\\.->|==>|---)(\\|[^|]+\\|)(\\w+)(;?.*)/)))
        return esc(m[1]) + wrap('id', m[2]) + wrap('op', m[3]) + wrap('label', m[4]) + wrap('id', m[5]) + esc(m[6]);
      // node declaration: id(label)
      if ((m = line.match(/^(\\s*)(\\w+)(\\([\\s\\S]*\\))(;?.*)/)))
        return esc(m[1]) + wrap('id', m[2]) + wrap('label', m[3]) + esc(m[4]);
      return esc(line);
    }).join('\\n');
  }
  document.getElementById('code-block').innerHTML = highlightMermaid(SOURCE);

  const btnCopy = document.getElementById('btn-copy');
  const iconCopy = document.getElementById('icon-copy');
  const iconCheck = document.getElementById('icon-check');
  btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(SOURCE).then(() => {
      iconCopy.style.display = 'none';
      iconCheck.style.display = '';
      setTimeout(() => { iconCopy.style.display = ''; iconCheck.style.display = 'none'; }, 1500);
    });
  });

  // ── Homepage logo ─────────────────────────────────────────────────────────
  const btnHomepage = document.getElementById('btn-homepage');
  if (btnHomepage && HOMEPAGE_URL && vscodeApi) {
    btnHomepage.addEventListener('click', () => {
      vscodeApi.postMessage({ command: 'openExternal', url: HOMEPAGE_URL });
    });
  }

  // ── Go to source ─────────────────────────────────────────────────────────
  document.getElementById('btn-goto-source').addEventListener('click', () => {
    if (vscodeApi) vscodeApi.postMessage({ command: 'gotoSource', uri: SOURCE_URI, line: SOURCE_LINE });
  });

  // ── Pan / Zoom ────────────────────────────────────────────────────────────
  const viewport  = document.getElementById('graph-viewport');
  const canvas    = document.getElementById('graph-canvas');
  const zoomLabel = document.getElementById('zoom-label');

  let scale = 1, tx = 0, ty = 0;
  let dragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;

  function applyTransform() {
    canvas.style.transform = \`translate(\${tx}px, \${ty}px) scale(\${scale})\`;
    zoomLabel.textContent = Math.round(scale * 100) + '%';
  }

  function fitView() {
    // Reset so we can measure the natural size
    canvas.style.transform = 'none';
    const svg = canvas.querySelector('svg');
    if (!svg) return;
    const svgRect = svg.getBoundingClientRect();
    const cw = svgRect.width, ch = svgRect.height;
    if (!cw || !ch) return;
    const pad = 48;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    scale = Math.min((vw - pad * 2) / cw, (vh - pad * 2) / ch);
    tx = (vw - cw * scale) / 2;
    ty = (vh - ch * scale) / 2;
    applyTransform();
  }

  // ── Render mermaid ───────────────────────────────────────────────────────
  function getMermaidTheme() {
    const cl = document.body.classList;
    if (cl.contains('vscode-high-contrast-light')) return 'neutral';
    if (cl.contains('vscode-high-contrast'))       return 'neutral';
    if (cl.contains('vscode-light'))               return 'default';
    return 'dark';
  }

  let activeJobName = null;
  function applyHighlight() {
    document.querySelectorAll('#diagram .node').forEach(node => {
      node.classList.remove('current-node');
    });
    if (!activeJobName) return;
    const prefix = 'flowchart-' + activeJobName + '-';
    document.querySelectorAll('#diagram .node').forEach(node => {
      if (node.id.startsWith(prefix)) node.classList.add('current-node');
    });
  }

  let renderCount = 0;
  function renderDiagram() {
    const id = 'mermaid-svg-' + (++renderCount);
    mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme(), flowchart: { curve: 'basis' } });
    mermaid.render(id, SOURCE).then(({ svg }) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svg, 'text/html');
      const svgNode = document.adoptNode(doc.querySelector('svg'));
      const container = document.getElementById('diagram');
      container.replaceChildren(svgNode);
      applyHighlight();
      requestAnimationFrame(() => requestAnimationFrame(fitView));
    });
  }

  renderDiagram();

  // Re-render when VS Code changes the color theme (body class changes)
  new MutationObserver(() => renderDiagram()).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  // ── Export ────────────────────────────────────────────────────────────────
  function getSvgString() {
    const svg = document.querySelector('#diagram svg');
    if (!svg) return null;
    const clone = svg.cloneNode(true);
    clone.style.background = 'transparent';
    const serializer = new XMLSerializer();
    return '<?xml version="1.0" encoding="UTF-8"?>\\n' + serializer.serializeToString(clone);
  }

  document.getElementById('btn-export-svg').addEventListener('click', () => {
    const data = getSvgString();
    if (data && vscodeApi) vscodeApi.postMessage({ command: 'exportSvg', data, exportBaseName: EXPORT_BASE_NAME });
  });

  document.getElementById('btn-export-png').addEventListener('click', () => {
    const svgStr = getSvgString();
    if (!svgStr || !vscodeApi) return;
    const svgEl = document.querySelector('#diagram svg');
    const rect = svgEl ? svgEl.getBoundingClientRect() : null;
    const w = (rect && rect.width  > 0 ? rect.width  : 800);
    const h = (rect && rect.height > 0 ? rect.height : 600);
    // Use a data: URI — blob: URLs are unreliable in VS Code WebViews
    const dataUri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Scale up for higher-resolution output (2×)
      const dpr = 2;
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.drawImage(img, 0, 0, w, h);
      const base64 = canvas.toDataURL('image/png').replace(/^data:image\\/png;base64,/, '');
      vscodeApi.postMessage({ command: 'exportPng', data: base64, exportBaseName: EXPORT_BASE_NAME });
    };
    img.onerror = () => {
      // Fall back: send SVG bytes to the host and let it handle conversion
      vscodeApi.postMessage({ command: 'exportPng', data: null, svgFallback: svgStr, exportBaseName: EXPORT_BASE_NAME });
    };
    img.src = dataUri;
  });

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    tx = mx - (mx - tx) * delta;
    ty = my - (my - ty) * delta;
    scale *= delta;
    applyTransform();
  }, { passive: false });

  viewport.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    dragging = true; startX = e.clientX; startY = e.clientY; startTx = tx; startTy = ty;
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    tx = startTx + e.clientX - startX;
    ty = startTy + e.clientY - startY;
    applyTransform();
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  document.getElementById('btn-zoom-in').addEventListener('click',  () => { scale *= 1.2; applyTransform(); });
  document.getElementById('btn-zoom-out').addEventListener('click', () => { scale /= 1.2; applyTransform(); });
  document.getElementById('btn-reset').addEventListener('click',    () => { scale = 1; tx = 0; ty = 0; applyTransform(); });
  document.getElementById('btn-fit').addEventListener('click',      fitView);

  // ── Active job node highlight ─────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.command !== 'highlightNode') return;
    activeJobName = event.data.jobName;
    applyHighlight();
  });
})();
</script>
</body>
</html>`;
}
