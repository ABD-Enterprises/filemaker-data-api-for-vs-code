import * as vscode from 'vscode';

import { createNonce } from './csp';

/**
 * The webview panels the extension opens, and the command that reopens each.
 *
 * VS Code restores an open webview tab when a window reloads or restarts. Without a serializer for
 * its view type the tab comes back as an empty, dead panel: the page script is gone and nothing
 * listens to it. These panels are rebuilt from live connection state, so they cannot be revived from
 * saved state; instead the restored tab shows a short page that says so and names the command that
 * opens a working one.
 */
export const RESTORABLE_PANELS: ReadonlyArray<{ viewType: string; reopenWith: string }> = [
  { viewType: 'filemakerConnectionWizard', reopenWith: 'FileMaker: Add Connection Profile' },
  { viewType: 'filemakerQueryBuilder', reopenWith: 'FileMaker: Open Query Builder' },
  { viewType: 'filemakerRecordViewer', reopenWith: 'FileMaker: Open Record Viewer' },
  { viewType: 'filemakerRecordEditor', reopenWith: 'FileMaker: Open Record Editor' },
  { viewType: 'filemakerScriptRunner', reopenWith: 'FileMaker: Open Script Runner' },
  { viewType: 'filemakerLayoutMode', reopenWith: 'FileMaker: Open FM Web Layout Mode' },
  { viewType: 'filemakerSchemaDiff', reopenWith: 'FileMaker: Diff Schema Snapshots' },
  { viewType: 'filemakerEnvironmentCompare', reopenWith: 'FileMaker: Compare Environments' },
  { viewType: 'filemakerDiagnosticsDashboard', reopenWith: 'FileMaker: Open Diagnostics Dashboard' },
  { viewType: 'filemakerEffectiveSettings', reopenWith: 'FileMaker: Show Effective Settings' }
];

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A static page: no script, nothing from the saved state. */
export function renderReopenPage(title: string, reopenWith: string): string {
  const nonce = createNonce();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';" />
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; line-height: 1.5; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head>
<body>
<h2>${escapeHtml(title)}</h2>
<p>This panel was closed when VS Code reloaded, so it has nothing to show. Close this tab and open it again: run <strong>${escapeHtml(reopenWith)}</strong> from the Command Palette.</p>
</body></html>`;
}

/** Registers a serializer for every panel type, so a restored tab shows the reopen page instead of staying dead. */
export function registerPanelRestoreGuards(): vscode.Disposable[] {
  return RESTORABLE_PANELS.map(({ viewType, reopenWith }) =>
    vscode.window.registerWebviewPanelSerializer(viewType, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
        panel.webview.html = renderReopenPage(panel.title || 'FileMaker', reopenWith);
      }
    })
  );
}
