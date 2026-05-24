import * as vscode from 'vscode';

import type { SchemaDiffResult } from '../../types/fm';
import { getWebviewI18nScript, localize } from '../../i18n';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { toRecord } from '../common/messageValidation';

interface SchemaDiffWebviewMessage {
  type: 'ready' | 'exportJson';
}

export class SchemaDiffPanel {
  private static currentPanel: SchemaDiffPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private diff: SchemaDiffResult
  ) {
    this.panel.webview.html = this.renderHtml(panel.webview);
    this.panel.onDidDispose(() => {
      SchemaDiffPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public static createOrShow(context: vscode.ExtensionContext, diff: SchemaDiffResult): void {
    if (SchemaDiffPanel.currentPanel) {
      SchemaDiffPanel.currentPanel.diff = diff;
      SchemaDiffPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      void SchemaDiffPanel.currentPanel.sendDiff();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerSchemaDiff',
      localize('webviews.schemaDiff.panelTitle', 'FileMaker Schema Diff'),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'schemaDiff', 'ui')
        ]
      }
    );

    SchemaDiffPanel.currentPanel = new SchemaDiffPanel(panel, context, diff);
  }

  private async handleMessage(message: unknown): Promise<void> {
    const incoming = parseMessage(message);
    if (!incoming) {
      return;
    }

    switch (incoming.type) {
      case 'ready':
        await this.sendDiff();
        break;
      case 'exportJson':
        await this.exportDiffJson();
        break;
      default:
        break;
    }
  }

  private async sendDiff(): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'diff',
      payload: this.diff
    });
  }

  private async exportDiffJson(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      title: localize('webviews.schemaDiff.export.title', 'Export schema diff JSON'),
      defaultUri: vscode.Uri.file(`schema-diff-${this.diff.layout}.json`),
      filters: {
        JSON: ['json']
      }
    });

    if (!uri) {
      return;
    }

    const bytes = Buffer.from(`${JSON.stringify(this.diff, null, 2)}\n`, 'utf8');
    await vscode.workspace.fs.writeFile(uri, bytes);
    vscode.window.showInformationMessage(
      localize('webviews.schemaDiff.export.success', 'Exported schema diff to {0}', uri.fsPath)
    );
  }

  private renderHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webviews',
        'schemaDiff',
        'ui',
        'styles.css'
      )
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webviews',
        'schemaDiff',
        'ui',
        'index.js'
      )
    );

    const nonce = createNonce();
    const csp = buildWebviewCsp(webview, {
      nonce
    });
    const i18nScript = getWebviewI18nScript(nonce);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>${localize('webviews.schemaDiff.htmlTitle', 'Schema Diff')}</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <main class="container">
    <header>
      <h1>${localize('webviews.schemaDiff.heading', 'FileMaker Schema Diff')}</h1>
      <p id="meta"></p>
      <div class="summary" id="summary" role="status" aria-live="polite"></div>
      <div class="actions">
        <button id="exportButton">${localize('webviews.schemaDiff.exportButton', 'Export Diff JSON')}</button>
      </div>
    </header>

    <section>
      <h2>${localize('webviews.schemaDiff.addedHeading', 'Added Fields')}</h2>
      <div id="added"></div>
    </section>

    <section>
      <h2>${localize('webviews.schemaDiff.removedHeading', 'Removed Fields')}</h2>
      <div id="removed"></div>
    </section>

    <section>
      <h2>${localize('webviews.schemaDiff.changedHeading', 'Changed Fields')}</h2>
      <div id="changed"></div>
    </section>
  </main>

  ${i18nScript}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseMessage(value: unknown): SchemaDiffWebviewMessage | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }

  if (record.type === 'ready') {
    return { type: 'ready' };
  }

  if (record.type === 'exportJson') {
    return { type: 'exportJson' };
  }

  return undefined;
}
