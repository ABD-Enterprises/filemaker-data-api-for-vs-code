import * as vscode from 'vscode';

import { buildWebviewCsp, createNonce } from '../webviews/common/csp';
import { hasMessageType } from '../webviews/common/messageValidation';
import type { NetworkLogStore } from './networkLogStore';

export class NetworkLogPanel {
  private static current: NetworkLogPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly networkLogStore: NetworkLogStore
  ) {
    this.disposables.push(
      this.panel.onDidDispose(() => {
        NetworkLogPanel.current = undefined;
        this.dispose();
      }),
      this.networkLogStore.onDidChange(() => {
        void this.render();
      }),
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (hasMessageType(message, 'refresh')) {
          void this.render();
          return;
        }

        if (hasMessageType(message, 'clear')) {
          void this.clear();
        }
      })
    );

    void this.render();
  }

  public static createOrShow(networkLogStore: NetworkLogStore): void {
    const column = vscode.ViewColumn.One;

    if (NetworkLogPanel.current) {
      NetworkLogPanel.current.panel.reveal(column);
      void NetworkLogPanel.current.render();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerNetworkLog',
      'FileMaker Network Log',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    NetworkLogPanel.current = new NetworkLogPanel(panel, networkLogStore);
  }

  private async clear(): Promise<void> {
    await this.networkLogStore.clear();
    await this.render();
  }

  private async render(): Promise<void> {
    const entries = this.networkLogStore.listEntries();
    const nonce = createNonce();
    const csp = buildWebviewCsp(this.panel.webview, {
      nonce,
      allowInlineStyleWithNonce: true
    });
    const payload = JSON.stringify({ entries }).replace(/</g, '\\u003c');

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>FileMaker Network Log</title>
  <style nonce="${nonce}">
    body { font-family: 'Segoe UI', sans-serif; margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .wrap { padding: 14px; display: grid; gap: 12px; }
    .toolbar { display: flex; align-items: center; gap: 8px; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 6px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .count { color: var(--vscode-descriptionForeground); font-size: 12px; margin-left: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid var(--vscode-panel-border); text-align: left; padding: 6px 8px; font-size: 12px; vertical-align: top; }
    th { background: var(--vscode-editorGroupHeader-tabsBackground); font-weight: 600; }
    tbody tr.request-row { cursor: pointer; }
    tbody tr.request-row:hover { background: var(--vscode-list-hoverBackground); }
    .time { width: 178px; }
    .method { width: 70px; }
    .status { width: 74px; }
    .duration { width: 92px; }
    .url { overflow-wrap: anywhere; }
    .ok { color: var(--vscode-testing-iconPassed); }
    .fail { color: var(--vscode-testing-iconFailed); }
    .details { display: none; background: var(--vscode-sideBar-background); }
    .details.open { display: table-row; }
    .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; padding: 8px 0; }
    .detail-block { min-width: 0; display: grid; gap: 4px; }
    .detail-title { font-weight: 600; color: var(--vscode-descriptionForeground); }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; max-height: 260px; overflow: auto; }
    .empty { color: var(--vscode-descriptionForeground); }
    @media (max-width: 720px) {
      .time { width: 130px; }
      .method, .status, .duration { width: 58px; }
      .detail-grid { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="toolbar">
      <button id="refreshBtn">Refresh</button>
      <button id="clearBtn">Clear</button>
      <span id="count" class="count"></span>
    </div>
    <table>
      <thead>
        <tr><th class="time">Timestamp</th><th class="method">Method</th><th class="url">URL</th><th class="status">Status</th><th class="duration">Duration</th></tr>
      </thead>
      <tbody id="entriesBody"></tbody>
    </table>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const payload = ${payload};
    const entries = payload.entries || [];
    const entriesBody = document.getElementById('entriesBody');
    const count = document.getElementById('count');

    count.textContent = entries.length + ' / 100 requests';
    entriesBody.innerHTML = entries.length
      ? entries.map((entry) => renderRow(entry)).join('')
      : '<tr><td colspan="5" class="empty">No network requests captured.</td></tr>';

    for (const row of document.querySelectorAll('.request-row')) {
      row.addEventListener('click', () => {
        const target = document.getElementById('details-' + row.dataset.id);
        if (target) {
          target.classList.toggle('open');
        }
      });
    }

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    function renderRow(entry) {
      const statusClass = entry.responseStatus && entry.responseStatus >= 400 ? 'fail' : 'ok';
      const status = entry.responseStatus ?? (entry.errorMessage ? 'Error' : '-');
      return '<tr class="request-row" data-id="' + escapeHtml(entry.id) + '">' +
        '<td>' + escapeHtml(formatTime(entry.timestamp)) + '</td>' +
        '<td>' + escapeHtml(entry.method) + '</td>' +
        '<td class="url">' + escapeHtml(entry.relativeUrl) + '</td>' +
        '<td class="' + statusClass + '">' + escapeHtml(status) + '</td>' +
        '<td>' + escapeHtml(entry.durationMs) + 'ms</td>' +
      '</tr>' +
      '<tr id="details-' + escapeHtml(entry.id) + '" class="details"><td colspan="5">' +
        '<div class="detail-grid">' +
          renderBlock('Full URL', entry.url) +
          renderBlock('Request Headers', entry.requestHeaders) +
          renderBlock('Request Body', entry.requestBody) +
          renderBlock('Response Headers', entry.responseHeaders) +
          renderBlock('Response Body', entry.responseBody) +
          renderBlock('Error', entry.errorMessage || '') +
        '</div>' +
      '</td></tr>';
    }

    function renderBlock(title, value) {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
      return '<div class="detail-block">' +
        '<div class="detail-title">' + escapeHtml(title) + '</div>' +
        '<pre>' + escapeHtml(text) + '</pre>' +
      '</div>';
    }

    function formatTime(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}
