import * as vscode from 'vscode';

import type { HistoryStore } from '../services/historyStore';
import type { MetricsStore } from './metricsStore';
import { buildWebviewCsp, createNonce } from '../webviews/common/csp';
import { hasMessageType } from '../webviews/common/messageValidation';
import { versionFooterHtml } from '../about/runtimeVersion';

export class DiagnosticsDashboardPanel {
  private static current: DiagnosticsDashboardPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly metricsStore: MetricsStore,
    private readonly historyStore: HistoryStore
  ) {
    this.panel.onDidDispose(() => {
      DiagnosticsDashboardPanel.current = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (hasMessageType(message, 'refresh')) {
        void this.render();
        return;
      }

      if (hasMessageType(message, 'clear')) {
        void this.clear();
      }
    });

    void this.render();
  }

  public static createOrShow(
    metricsStore: MetricsStore,
    historyStore: HistoryStore
  ): void {
    const column = vscode.ViewColumn.One;

    if (DiagnosticsDashboardPanel.current) {
      DiagnosticsDashboardPanel.current.panel.reveal(column);
      void DiagnosticsDashboardPanel.current.render();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerDiagnosticsDashboard',
      'FileMaker Diagnostics Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    DiagnosticsDashboardPanel.current = new DiagnosticsDashboardPanel(panel, metricsStore, historyStore);
  }

  private async clear(): Promise<void> {
    await this.metricsStore.clear();
    await this.historyStore.clear();
    await this.render();
    vscode.window.showInformationMessage('Cleared FileMaker diagnostics metrics and request history.');
  }

  private async render(): Promise<void> {
    const summary = this.metricsStore.getSummary();
    const endpointRows = summary.endpoints.slice(0, 25);
    const recentHistory = this.historyStore.listEntries().slice(0, 20);

    const nonce = createNonce();
    const csp = buildWebviewCsp(this.panel.webview, {
      nonce,
      allowInlineStyleWithNonce: true
    });
    const payload = JSON.stringify({
      summary,
      endpointRows,
      recentHistory
    }).replace(/</g, '\\u003c');

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Diagnostics Dashboard</title>
  <style nonce="${nonce}">
    body { font-family: 'Segoe UI', sans-serif; margin: 0; background: #f6f8fb; color: #1f2937; }
    .wrap { padding: 16px; display: grid; gap: 14px; min-width: 0; }
    .card { background: #fff; border: 1px solid #d8e0eb; border-radius: 10px; padding: 12px; min-width: 0; }
    .table-scroll { overflow-x: auto; max-width: 100%; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 8px; }
    .stat { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; }
    .label { color: #64748b; font-size: 12px; }
    .value { font-weight: 700; font-size: 18px; margin-top: 4px; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e2e8f0; text-align: left; padding: 6px 8px; font-size: 12px; }
    th { background: #f8fafc; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
    button { border: none; border-radius: 6px; background: #0f766e; color: #fff; padding: 7px 10px; cursor: pointer; }
    button:hover { background: #115e59; }
    .muted { color: #64748b; }
    .fm-version { color: #64748b; font-size: 11px; padding: 0 16px 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="actions">
        <button id="refreshBtn">Refresh</button>
        <button id="clearBtn">Clear Metrics</button>
      </div>
      <div id="summary" class="stats"></div>
    </div>

    <div class="card">
      <h3>Endpoint Metrics (Last 200 requests)</h3>
      <div class="table-scroll"><table>
        <thead>
          <tr><th>Operation</th><th>Endpoint</th><th>Count</th><th>Avg ms</th><th>Success</th><th>Failure</th><th>401 Re-auth</th><th>Cache Hit %</th></tr>
        </thead>
        <tbody id="endpointsBody"></tbody>
      </table></div>
    </div>

    <div class="card">
      <h3>Recent Request History</h3>
      <div class="table-scroll"><table>
        <thead>
          <tr><th>Timestamp</th><th>Operation</th><th>Profile</th><th>Duration</th><th>Status</th><th>HTTP</th></tr>
        </thead>
        <tbody id="historyBody"></tbody>
      </table></div>
    </div>
  </div>
  ${versionFooterHtml()}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const payload = ${payload};

    const summary = payload.summary;
    const endpointRows = payload.endpointRows;
    const recentHistory = payload.recentHistory;

    const summaryEl = document.getElementById('summary');
    const endpointsBody = document.getElementById('endpointsBody');
    const historyBody = document.getElementById('historyBody');

    const stats = [
      ['Total Requests', summary.totalRequests],
      ['Success', summary.successCount],
      ['Failures', summary.failureCount],
      ['Avg Latency (ms)', summary.avgDurationMs],
      ['401 Re-auth', summary.totalReauthCount],
      ['Cache Hit Ratio', toPercent(summary.cacheHitRatio)]
    ];

    summaryEl.innerHTML = stats.map((pair) => {
      const label = pair[0];
      const value = pair[1];
      return '<div class="stat">' +
        '<div class="label">' + escapeHtml(label) + '</div>' +
        '<div class="value">' + escapeHtml(value) + '</div>' +
      '</div>';
    }).join('');

    endpointsBody.innerHTML = endpointRows.length
      ? endpointRows.map((row) => {
        return '<tr>' +
          '<td>' + escapeHtml(row.operation) + '</td>' +
          '<td>' + escapeHtml(row.endpoint) + '</td>' +
          '<td>' + row.count + '</td>' +
          '<td>' + row.avgDurationMs + '</td>' +
          '<td>' + row.successCount + '</td>' +
          '<td>' + row.failureCount + '</td>' +
          '<td>' + row.reauthCount + '</td>' +
          '<td>' + toPercent(row.cacheHitRatio) + '</td>' +
        '</tr>';
      }).join('')
      : '<tr><td colspan="8" class="muted">No metrics yet.</td></tr>';

    historyBody.innerHTML = recentHistory.length
      ? recentHistory.map((entry) => {
        return '<tr>' +
          '<td>' + escapeHtml(entry.timestamp) + '</td>' +
          '<td>' + escapeHtml(entry.operation) + '</td>' +
          '<td>' + escapeHtml(entry.profileId) + '</td>' +
          '<td>' + entry.durationMs + 'ms</td>' +
          '<td>' + (entry.success ? 'Success' : 'Failure') + '</td>' +
          '<td>' + (entry.httpStatus ?? '-') + '</td>' +
        '</tr>';
      }).join('')
      : '<tr><td colspan="6" class="muted">No history entries yet.</td></tr>';

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    function toPercent(value) {
      return String(Math.round((value || 0) * 100)) + '%';
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
}
