import * as path from 'path';
import * as vscode from 'vscode';
import { validateGotoSource } from './gotoSource';
import { validateOpenExternal } from './openExternal';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

// Tracks open graph panels: file URI string → { panel, offset, mermaidWebviewUri, codiconCssUri, cspSource }
const graphPanels = new Map<string, { panel: vscode.WebviewPanel; offset: number; mermaidWebviewUri: string; codiconCssUri: string; cspSource: string }>();
const DEBOUNCE_MS = 600;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

class WorkflowCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();

    // Match `public static function <name>(): WorkflowInterface` (with optional namespace prefix)
    const methodRegex = /\bpublic\s+static\s+function\s+\w+\s*\(\s*\)\s*:\s*(?:[\w\\]+\\)?WorkflowInterface\b/g;

    let match: RegExpExecArray | null;
    while ((match = methodRegex.exec(text)) !== null) {
      const pos = document.positionAt(match.index);
      const range = new vscode.Range(pos, pos);
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(type-hierarchy) Show Job Graph',
          command: 'chevereWorkflow.showJobGraph',
          arguments: [document.uri, document.offsetAt(pos)],
        })
      );
    }

    return lenses;
  }
}

async function refreshPanel(uriString: string, offset: number): Promise<void> {
  const entry = graphPanels.get(uriString);
  if (!entry) return;
  const result = await client.sendRequest('chevereWorkflow/jobGraph', {
    uri: uriString,
    offset,
    mermaidScriptUri: entry.mermaidWebviewUri,
    codiconCssUri: entry.codiconCssUri,
    cspSource: entry.cspSource,
  });
  if (result && graphPanels.has(uriString)) {
    entry.panel.webview.html = result as string;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const serverModule = context.asAbsolutePath(
    path.join('server', 'out', 'server.js')
  );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const mermaidDistPath = context.asAbsolutePath(path.join('dist', 'vendor'));
  const mermaidScriptDiskPath = vscode.Uri.file(
    path.join(mermaidDistPath, 'mermaid.min.js')
  );
  const codiconDistPath = context.asAbsolutePath(path.join('dist', 'vendor', 'codicons'));
  const codiconCssDiskPath = vscode.Uri.file(
    path.join(codiconDistPath, 'codicon.css')
  );

  const clientOptions: LanguageClientOptions = {
    // Activate only for PHP files
    documentSelector: [{ scheme: 'file', language: 'php' }],
    synchronize: {
      // Re-analyze when PHP files change (new callables may appear)
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.php'),
    },
    initializationOptions: {
      phpExecutable:
        vscode.workspace
          .getConfiguration('chevereWorkflow')
          .get<string>('phpExecutable') ?? 'php',
      composerJsonPath:
        vscode.workspace
          .getConfiguration('chevereWorkflow')
          .get<string>('composerJsonPath') ?? '',
    },
  };

  client = new LanguageClient(
    'chevereWorkflow',
    'Chevere Workflow',
    serverOptions,
    clientOptions
  );

  client.start();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file', language: 'php' },
      new WorkflowCodeLensProvider()
    )
  );

  // Highlight the active job node in open graph panels when the cursor moves
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async e => {
      const uriString = e.textEditor.document.uri.toString();
      const entry = graphPanels.get(uriString);
      if (!entry) return;
      const offset = e.textEditor.document.offsetAt(e.selections[0].active);
      const jobs = await client.sendRequest<{ name: string; start: number; end: number }[]>(
        'chevereWorkflow/jobPositions',
        { uri: uriString }
      );
      const active = jobs.find(j => offset >= j.start && offset <= j.end);
      entry.panel.webview.postMessage({ command: 'highlightNode', jobName: active?.name ?? null });
    })
  );

  // Live-update open graph panels on document change (debounced)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      const uriString = e.document.uri.toString();
      if (!graphPanels.has(uriString)) return;
      const existing = debounceTimers.get(uriString);
      if (existing) clearTimeout(existing);
      debounceTimers.set(uriString, setTimeout(() => {
        debounceTimers.delete(uriString);
        const entry = graphPanels.get(uriString);
        if (entry) refreshPanel(uriString, entry.offset);
      }, DEBOUNCE_MS));
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('chevereWorkflow.restartServer', () => {
      client.restart();
      vscode.window.showInformationMessage('Chevere Workflow server restarted.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chevereWorkflow.installWorkflow', () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          'Chevere Workflow: Cannot run composer in an untrusted workspace.'
        );
        return;
      }
      const folders = vscode.workspace.workspaceFolders;
      const cwd = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
      const terminal = vscode.window.createTerminal({
        name: 'Chevere Workflow: Composer',
        cwd,
      });
      terminal.show();
      terminal.sendText('composer require chevere/workflow');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'chevereWorkflow.showJobGraph',
      async (docUri?: vscode.Uri, docOffset?: number) => {
        const editor = vscode.window.activeTextEditor;
        const uri = docUri ?? editor?.document.uri;
        if (!uri) return;
        const doc = await vscode.workspace.openTextDocument(uri);
        const offset = docOffset ?? (editor ? doc.offsetAt(editor.selection.active) : 0);
        const uriString = uri.toString();

        // If a panel for this URI is already open, reveal it instead of creating a new one
        const existing = graphPanels.get(uriString);
        if (existing) {
          existing.panel.reveal(vscode.ViewColumn.Beside, true);
          return;
        }

        const fileName = uri.path.split('/').pop() ?? uri.path;
        const panel = vscode.window.createWebviewPanel(
          'chevereJobGraph',
          `Job Graph — ${fileName}`,
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(mermaidDistPath), vscode.Uri.file(codiconDistPath)],
          }
        );

        // Resolve the mermaid script URI and CSP source in the context of this webview
        const mermaidWebviewUri = panel.webview.asWebviewUri(mermaidScriptDiskPath).toString();
        const codiconCssUri = panel.webview.asWebviewUri(codiconCssDiskPath).toString();
        const cspSource = panel.webview.cspSource;

        const result = await client.sendRequest('chevereWorkflow/jobGraph', {
          uri: uriString,
          offset,
          mermaidScriptUri: mermaidWebviewUri,
          codiconCssUri,
          cspSource,
        });
        if (result) {
          panel.webview.html = result as string;
          graphPanels.set(uriString, { panel, offset, mermaidWebviewUri, codiconCssUri, cspSource });

          panel.onDidDispose(() => {
            graphPanels.delete(uriString);
            const timer = debounceTimers.get(uriString);
            if (timer) { clearTimeout(timer); debounceTimers.delete(uriString); }
          });

          panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'openExternal') {
              const safeUrl = validateOpenExternal(msg.url);
              if (safeUrl) vscode.env.openExternal(vscode.Uri.parse(safeUrl));
            } else if (msg.command === 'gotoSource') {
              const workspaceFsPaths = (vscode.workspace.workspaceFolders ?? [])
                .map(f => f.uri.fsPath);
              const validated = validateGotoSource(msg.uri, msg.line, workspaceFsPaths);
              if (!validated) return;
              const targetUri = vscode.Uri.file(validated.fsPath);
              const targetDoc = await vscode.workspace.openTextDocument(targetUri);
              const existingEditor = vscode.window.visibleTextEditors.find(
                e => e.document.uri.toString() === targetUri.toString()
              );
              await vscode.window.showTextDocument(targetDoc, {
                selection: new vscode.Range(validated.line, 0, validated.line, 0),
                preserveFocus: false,
                viewColumn: existingEditor?.viewColumn,
              });
            } else if (msg.command === 'exportSvg' || msg.command === 'exportPng') {
              const isSvg = msg.command === 'exportSvg';
              // PNG canvas rendering may fall back to raw SVG bytes if toDataURL fails
              const useSvgFallback = !isSvg && msg.data == null && typeof msg.svgFallback === 'string';
              const ext = isSvg || useSvgFallback ? 'svg' : 'png';
              const baseName = typeof msg.exportBaseName === 'string' ? msg.exportBaseName : 'workflow-graph';
              const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${baseName}.${ext}`),
                filters: ext === 'svg' ? { 'SVG Image': ['svg'] } : { 'PNG Image': ['png'] },
              });
              if (!saveUri) return;
              let bytes: Uint8Array;
              if (isSvg || useSvgFallback) {
                const src = isSvg ? (msg.data as string) : (msg.svgFallback as string);
                bytes = Buffer.from(src, 'utf8');
              } else {
                bytes = Buffer.from(msg.data as string, 'base64');
              }
              await vscode.workspace.fs.writeFile(saveUri, bytes);
              if (useSvgFallback) {
                vscode.window.showWarningMessage(
                  `PNG rendering failed in this environment — saved as SVG instead: ${saveUri.fsPath}`
                );
              } else {
                vscode.window.showInformationMessage(`Graph saved to ${saveUri.fsPath}`);
              }
            }
          });
        } else {
          panel.dispose();
          vscode.window.showWarningMessage(
            'No workflow graph found. Make sure the active file is a Chevere Workflow PHP file.'
          );
        }
      }
    )
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
