import * as fs from 'fs';
import * as path from 'path';
import {
  CompletionList,
  createConnection,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { computeCompletions } from './completion';
import { computeDiagnostics } from './diagnostics';
import { computeHover } from './hover';
import { computeInlayHints } from './inlayHints';
import { buildJobGraphHtml } from './jobGraph';
import { parseDocument } from './parser';
import { invalidateCache } from './reflector';
import { invalidateLintCache } from './linter';
import { isValidPhpExecutable } from './phpExecutable';

// ─── Connection setup ────────────────────────────────────────────────────────
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ─── Static manifest metadata ────────────────────────────────────────────────
const _pkgPath = path.join(__dirname, '..', '..', 'package.json');
const _pkg = JSON.parse(fs.readFileSync(_pkgPath, 'utf8')) as { homepage?: string };
const HOMEPAGE_URL: string | undefined = _pkg.homepage;

// ─── Config (set on initialize) ─────────────────────────────────────────────
let phpExecutable = 'php';
let autoloaderPath = '';
let showParameterTypes = true;
let showResponseTypes = true;

function findAutoloader(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'vendor', 'autoload.php');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isWithinWorkspace(filePath: string, workspaceFolders: string[]): boolean {
  return workspaceFolders.some(root => filePath.startsWith(root + path.sep) || filePath === root);
}

// ─── Initialize ─────────────────────────────────────────────────────────────
connection.onInitialize((params: InitializeParams): InitializeResult => {
  const opts = params.initializationOptions ?? {};
  phpExecutable = opts.phpExecutable ?? 'php';

  const workspacePaths = (params.workspaceFolders ?? []).map(f => new URL(f.uri).pathname);
  if (opts.composerJsonPath) {
    const resolved = path.join(path.dirname(opts.composerJsonPath), 'vendor', 'autoload.php');
    if (isWithinWorkspace(resolved, workspacePaths)) {
      autoloaderPath = resolved;
    }
  } else if (workspacePaths[0]) {
    autoloaderPath = findAutoloader(workspacePaths[0]) ?? '';
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      completionProvider: {
        triggerCharacters: [',', '(', ' '],
        resolveProvider: false,
      },
      inlayHintProvider: { resolveProvider: false },
    },
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getConfig() {
  return { phpExecutable, autoloaderPath, homepageUrl: HOMEPAGE_URL };
}

function getParsed(document: TextDocument) {
  return parseDocument(document.getText());
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────
async function validateDocument(document: TextDocument) {
  if (!autoloaderPath) return;
  const parsed = getParsed(document);
  const diagnostics = await computeDiagnostics(document, parsed, getConfig());
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

const _changeTimers = new Map<string, ReturnType<typeof setTimeout>>();
documents.onDidChangeContent((change) => {
  const uri = change.document.uri;
  const existing = _changeTimers.get(uri);
  if (existing) clearTimeout(existing);
  _changeTimers.set(uri, setTimeout(() => {
    _changeTimers.delete(uri);
    validateDocument(change.document);
  }, 500));
});

documents.onDidSave((event) => {
  // Invalidate caches when a PHP file is saved (signature or values may have changed)
  invalidateCache();
  invalidateLintCache();
  validateDocument(event.document);
});

// ─── Hover ───────────────────────────────────────────────────────────────────
connection.onHover(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !autoloaderPath) return null;
  const parsed = getParsed(document);
  return computeHover(document, params.position, parsed, getConfig());
});

// ─── Completion ───────────────────────────────────────────────────────────────
connection.onCompletion(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !autoloaderPath) return null;
  const parsed = getParsed(document);
  const items = await computeCompletions(document, params.position, parsed, getConfig());
  return CompletionList.create(items, false);
});

// ─── Inlay Hints ─────────────────────────────────────────────────────────────
connection.languages.inlayHint.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !autoloaderPath) return [];
  const parsed = getParsed(document);
  return computeInlayHints(document, parsed, params.range, {
    ...getConfig(),
    showParameterTypes,
    showResponseTypes,
  });
});

// ─── Custom request: job positions ───────────────────────────────────────────
connection.onRequest('chevereWorkflow/jobPositions', (params: { uri: string }) => {
  const document = documents.get(params.uri);
  if (!document) return [];
  const parsed = parseDocument(document.getText());
  const result: { name: string; start: number; end: number }[] = [];
  for (const wc of parsed.workflowCalls) {
    for (const { name, call } of wc.jobs) {
      result.push({ name, start: call.callStart, end: call.callEnd });
    }
  }
  return result;
});

// ─── Custom request: job graph ────────────────────────────────────────────────
connection.onRequest('chevereWorkflow/jobGraph', async (params: { uri: string; offset?: number; mermaidScriptUri?: string; codiconCssUri?: string; cspSource?: string }) => {
  const document = documents.get(params.uri);
  if (!document) return null;
  const parsed = getParsed(document);
  const config = {
    ...getConfig(),
    mermaidScriptUri: params.mermaidScriptUri,
    codiconCssUri: params.codiconCssUri,
    cspSource: params.cspSource,
  };
  return buildJobGraphHtml(parsed, config, params.uri, params.offset);
});

// ─── Config change ────────────────────────────────────────────────────────────
connection.onNotification('chevereWorkflow/configChange', (newConfig: Record<string, unknown>) => {
  if (typeof newConfig.phpExecutable === 'string' && isValidPhpExecutable(newConfig.phpExecutable)) {
    phpExecutable = newConfig.phpExecutable;
  }
  if (newConfig.showParameterTypes !== undefined) showParameterTypes = newConfig.showParameterTypes as boolean;
  if (newConfig.showResponseTypes !== undefined) showResponseTypes = newConfig.showResponseTypes as boolean;
  invalidateCache();
  invalidateLintCache();
});

documents.listen(connection);
connection.listen();
