import * as vscode from 'vscode';

import type { EnvironmentCompareResult, LayoutEnvironmentDiffResult } from '../../types/fm';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { versionFooterHtml } from '../../about/runtimeVersion';

interface EnvironmentComparePanelPayload {
  compare?: EnvironmentCompareResult;
  layoutDiff?: LayoutEnvironmentDiffResult;
}

export class EnvironmentComparePanel {
  private static current: EnvironmentComparePanel | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    this.panel.onDidDispose(() => {
      EnvironmentComparePanel.current = undefined;
    });
  }

  public static createOrShow(
    payload: EnvironmentComparePanelPayload,
    title = 'FileMaker Environment Compare'
  ): void {
    const column = vscode.ViewColumn.One;

    if (EnvironmentComparePanel.current) {
      EnvironmentComparePanel.current.panel.reveal(column);
      EnvironmentComparePanel.current.panel.title = title;
      EnvironmentComparePanel.current.panel.webview.html = buildHtml(
        EnvironmentComparePanel.current.panel.webview,
        payload
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel('filemakerEnvironmentCompare', title, column, {
      enableScripts: false,
      retainContextWhenHidden: true
    });

    panel.webview.html = buildHtml(panel.webview, payload);
    EnvironmentComparePanel.current = new EnvironmentComparePanel(panel);
  }
}

function buildHtml(webview: vscode.Webview, payload: EnvironmentComparePanelPayload): string {
  const nonce = createNonce();
  const csp = buildWebviewCsp(webview, {
    nonce,
    allowInlineStyleWithNonce: true
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Environment Compare</title>
  <style nonce="${nonce}">
    body { margin: 0; font-family: 'Segoe UI', sans-serif; background: var(--vscode-editor-background, #ffffff); color: var(--vscode-foreground, #333333); }
    .wrap { padding: 16px; display: grid; gap: 14px; }
    .card { background: var(--vscode-editorWidget-background, #f3f3f3); border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, #cccccc)); border-radius: 10px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, #cccccc)); text-align: left; padding: 6px 8px; font-size: 12px; }
    th { background: var(--vscode-editor-background, #ffffff); }
    .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 11px; }
    .ok { background: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, var(--vscode-foreground, #333333)))) 12%, var(--vscode-editor-background, #ffffff)); color: var(--vscode-foreground, #333333); }
    .warn { background: var(--vscode-inputValidation-warningBackground, #fff4ce); color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground, #333333)); }
    .bad { background: var(--vscode-inputValidation-errorBackground, #f2dede); color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground, #333333)); }
    details { margin-bottom: 6px; }
    .fm-version { color: color-mix(in srgb, var(--vscode-descriptionForeground, var(--vscode-foreground, #333333)) 75%, var(--vscode-foreground, #333333)); font-size: 11px; padding: 0 16px 12px; }
    summary { cursor: pointer; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    ${payload.compare ? renderCompare(payload.compare) : ''}
    ${payload.layoutDiff ? renderLayoutDiff(payload.layoutDiff) : ''}
  </div>
  ${versionFooterHtml()}
</body>
</html>`;
}

function renderCompare(compare: EnvironmentCompareResult): string {
  const rows = compare.rows
    .map((row) => {
      const presence = Object.entries(row.presence)
        .map(([profileId, present]) => `${escapeHtml(profileId)}=${present ? 'Y' : 'N'}`)
        .join(' | ');
      const hashes = Object.values(row.metadataHashes).filter((value): value is string => Boolean(value));
      const hashVariants = new Set(hashes).size;
      const scripts = Object.entries(row.scripts)
        .map(([profileId, values]) => `${escapeHtml(profileId)}(${values.length})`)
        .join(' | ');

      return `<tr>
        <td>${escapeHtml(row.layout)}</td>
        <td>${presence || '-'}</td>
        <td>${hashVariants}</td>
        <td>${scripts || '-'}</td>
      </tr>`;
    })
    .join('');

  return `<section class="card">
    <h2>Environment Set: ${escapeHtml(compare.environmentSetName)}</h2>
    <p>Generated ${escapeHtml(compare.generatedAt)}</p>
    <p>
      <span class="badge ok">Profiles: ${compare.summary.profileCount}</span>
      <span class="badge warn">Layouts: ${compare.summary.totalLayouts}</span>
      <span class="badge bad">Differences: ${compare.summary.differentLayouts}</span>
    </p>
    <table>
      <thead>
        <tr><th>Layout</th><th>Presence Matrix</th><th>Metadata Hash Variants</th><th>Scripts</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderLayoutDiff(diff: LayoutEnvironmentDiffResult): string {
  const details = diff.profileResults
    .map((profileResult) => {
      const changedFields = profileResult.changedFields
        .map(
          (item) =>
            `${escapeHtml(item.fieldName)} [${item.attributes.map((attribute) => escapeHtml(attribute)).join(', ')}]`
        )
        .join('; ');

      return `<details>
        <summary>${escapeHtml(profileResult.profileId)} ${profileResult.available ? '' : '(metadata unavailable)'}
          <span class="badge ok">+${profileResult.addedFields.length}</span>
          <span class="badge bad">-${profileResult.removedFields.length}</span>
          <span class="badge warn">Δ${profileResult.changedFields.length}</span>
        </summary>
        <div>
          <p>Metadata hash: ${escapeHtml(profileResult.metadataHash ?? 'n/a')}</p>
          <p>Scripts: ${profileResult.scripts.map((script) => escapeHtml(script)).join(', ') || '-'}</p>
          <p>Added fields: ${profileResult.addedFields.map((field) => escapeHtml(field)).join(', ') || '-'}</p>
          <p>Removed fields: ${profileResult.removedFields.map((field) => escapeHtml(field)).join(', ') || '-'}</p>
          <p>Changed fields: ${changedFields || '-'}</p>
        </div>
      </details>`;
    })
    .join('');

  return `<section class="card">
    <h2>Layout Diff: ${escapeHtml(diff.layout)}</h2>
    <p>Environment Set: ${escapeHtml(diff.environmentSetName)} • Baseline: ${escapeHtml(diff.baselineProfileId)}</p>
    ${details}
  </section>`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
