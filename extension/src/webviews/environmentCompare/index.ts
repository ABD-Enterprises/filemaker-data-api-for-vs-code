import * as vscode from 'vscode';

import type { EnvironmentCompareResult, LayoutEnvironmentDiffResult } from '../../types/fm';
import { localize } from '../../i18n';
import { buildWebviewCsp, createNonce } from '../common/csp';

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
    title = localize('webviews.environmentCompare.panelTitle', 'FileMaker Environment Compare')
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
  <title>${localize('webviews.environmentCompare.htmlTitle', 'Environment Compare')}</title>
  <style nonce="${nonce}">
    body { margin: 0; font-family: 'Segoe UI', sans-serif; background: #f6f9fc; color: #1f2937; }
    .wrap { padding: 16px; display: grid; gap: 14px; }
    .card { background: #fff; border: 1px solid #dbe3ee; border-radius: 10px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #dbe3ee; text-align: left; padding: 6px 8px; font-size: 12px; }
    th { background: #f1f5f9; }
    .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 11px; }
    .ok { background: #dcfce7; color: #14532d; }
    .warn { background: #fef3c7; color: #7c2d12; }
    .bad { background: #fee2e2; color: #7f1d1d; }
    details { margin-bottom: 6px; }
    summary { cursor: pointer; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    ${payload.compare ? renderCompare(payload.compare) : ''}
    ${payload.layoutDiff ? renderLayoutDiff(payload.layoutDiff) : ''}
  </div>
</body>
</html>`;
}

function renderCompare(compare: EnvironmentCompareResult): string {
  const rows = compare.rows
    .map((row) => {
      const presence = Object.entries(row.presence)
        .map(([profileId, present]) => `${escapeHtml(profileId)}=${present ? 'Y' : 'N'}`)
        .join(' | ');
      const hashes = Object.values(row.metadataHashes).filter((value): value is string =>
        Boolean(value)
      );
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
    <h2>${escapeHtml(localize('webviews.environmentCompare.environmentSetHeading', 'Environment Set: {0}', compare.environmentSetName))}</h2>
    <p>${escapeHtml(localize('webviews.environmentCompare.generated', 'Generated {0}', compare.generatedAt))}</p>
    <p>
      <span class="badge ok">${escapeHtml(localize('webviews.environmentCompare.profilesBadge', 'Profiles: {0}', compare.summary.profileCount))}</span>
      <span class="badge warn">${escapeHtml(localize('webviews.environmentCompare.layoutsBadge', 'Layouts: {0}', compare.summary.totalLayouts))}</span>
      <span class="badge bad">${escapeHtml(localize('webviews.environmentCompare.differencesBadge', 'Differences: {0}', compare.summary.differentLayouts))}</span>
    </p>
    <table>
      <thead>
        <tr><th>${escapeHtml(localize('webviews.environmentCompare.layoutHeader', 'Layout'))}</th><th>${escapeHtml(localize('webviews.environmentCompare.presenceHeader', 'Presence Matrix'))}</th><th>${escapeHtml(localize('webviews.environmentCompare.hashVariantsHeader', 'Metadata Hash Variants'))}</th><th>${escapeHtml(localize('webviews.environmentCompare.scriptsHeader', 'Scripts'))}</th></tr>
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
        <summary>${escapeHtml(profileResult.profileId)} ${profileResult.available ? '' : escapeHtml(localize('webviews.environmentCompare.metadataUnavailable', '(metadata unavailable)'))}
          <span class="badge ok">+${profileResult.addedFields.length}</span>
          <span class="badge bad">-${profileResult.removedFields.length}</span>
          <span class="badge warn">Δ${profileResult.changedFields.length}</span>
        </summary>
        <div>
          <p>${escapeHtml(localize('webviews.environmentCompare.metadataHash', 'Metadata hash: {0}', profileResult.metadataHash ?? 'n/a'))}</p>
          <p>${escapeHtml(localize('webviews.environmentCompare.scripts', 'Scripts: {0}', profileResult.scripts.join(', ') || '-'))}</p>
          <p>${escapeHtml(localize('webviews.environmentCompare.addedFields', 'Added fields: {0}', profileResult.addedFields.join(', ') || '-'))}</p>
          <p>${escapeHtml(localize('webviews.environmentCompare.removedFields', 'Removed fields: {0}', profileResult.removedFields.join(', ') || '-'))}</p>
          <p>${escapeHtml(localize('webviews.environmentCompare.changedFields', 'Changed fields: {0}', changedFields || '-'))}</p>
        </div>
      </details>`;
    })
    .join('');

  return `<section class="card">
    <h2>${escapeHtml(localize('webviews.environmentCompare.layoutDiffHeading', 'Layout Diff: {0}', diff.layout))}</h2>
    <p>${escapeHtml(localize('webviews.environmentCompare.layoutDiffMeta', 'Environment Set: {0} • Baseline: {1}', diff.environmentSetName, diff.baselineProfileId))}</p>
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
