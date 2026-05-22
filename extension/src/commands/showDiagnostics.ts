import * as os from 'node:os';

import * as vscode from 'vscode';

/**
 * Build a diagnostic dump as a markdown string. Designed to be pasted into
 * a bug report — credentials, tokens, server URLs, and other potentially
 * sensitive context are explicitly redacted, NOT included for the user to
 * redact manually.
 *
 * Distinct from the Diagnostics Dashboard webview (see diagnostics.ts /
 * diagnosticsDashboard) — that one shows live metrics; this one captures
 * a one-shot snapshot ready to paste.
 *
 * Closes #176.
 */
export async function buildDiagnosticReport(
  context: vscode.ExtensionContext
): Promise<string> {
  const lines: string[] = [];
  const push = (text: string) => lines.push(text);

  // Header ---------------------------------------------------------------
  push('# FileMaker Data API Tools — Diagnostic Report');
  push('');
  push('_Paste this into a bug report. Secrets are already redacted; no further redaction needed._');
  push('');
  push(`Generated: ${new Date().toISOString()}`);
  push('');

  // Environment ----------------------------------------------------------
  push('## Environment');
  push('');
  push('| Key | Value |');
  push('| --- | --- |');
  push(`| VS Code version | ${vscode.version} |`);
  push(`| Extension version | ${context.extension.packageJSON.version ?? 'unknown'} |`);
  push(`| Extension ID | ${context.extension.id} |`);
  push(`| Extension mode | ${context.extensionMode === 1 ? 'Production' : context.extensionMode === 2 ? 'Development' : 'Test'} |`);
  push(`| OS | ${os.platform()} ${os.release()} (${os.arch()}) |`);
  push(`| Node | ${process.version} |`);
  push(`| Workspace trusted | ${vscode.workspace.isTrusted} |`);
  push('');

  // Active profile (redacted) -------------------------------------------
  push('## Active profile');
  push('');
  const profiles = (context.globalState.get<unknown[]>('filemaker.profiles', []) ?? []) as {
    id?: string;
    name?: string;
  }[];
  const activeProfileId = context.workspaceState.get<string>('filemaker.activeProfileId')
    ?? context.globalState.get<string>('filemaker.activeProfileId');
  if (!profiles.length) {
    push('_No profiles configured._');
  } else {
    const activeProfile = profiles.find(p => p?.id === activeProfileId);
    if (activeProfile) {
      push(`- Name: \`${activeProfile.name ?? '(unnamed)'}\``);
      push('- Credentials: **redacted** (stored in OS keychain / SecretStorage)');
      push('- Server URL: **redacted** (treated as semi-sensitive)');
    } else {
      push(`_${profiles.length} profile(s) configured; none currently active._`);
    }
  }
  push('');

  // Settings -------------------------------------------------------------
  push('## Settings (filemaker.*)');
  push('');
  push('```jsonc');
  const config = vscode.workspace.getConfiguration('filemaker');
  const settingsKeys = [
    'logging.level',
    'requestTimeoutMs',
    'features.batch.enabled',
    'features.recordEdit.enabled',
    'features.scriptRunner.enabled',
    'enterprise.mode',
    'enterprise.role',
    'savedQueries.scope',
    'advanced.powerUserMode',
    'schema.hashAlgorithm',
  ];
  for (const key of settingsKeys) {
    const value = config.get(key);
    push(`  "filemaker.${key}": ${JSON.stringify(value)},`);
  }
  push('```');
  push('');

  // Recent log entries placeholder --------------------------------------
  push('## Recent log entries');
  push('');
  push(
    '_Run **FileMaker: Open Output Panel** to see the live log. VS Code does not expose the OutputChannel buffer to extensions; copy the panel content manually if relevant to the bug._'
  );
  push('');

  // Footer ---------------------------------------------------------------
  push('---');
  push('');
  push('**What is NOT in this report (because we never store / never log it):**');
  push('- Your FileMaker server URL');
  push('- Your username, password, or session token');
  push('- Layout / table / field names from your database');
  push('- Query payloads or response data');
  push('');
  push(
    'If you want to include any of those, add them MANUALLY after pasting this report — and double-check the redaction.'
  );

  return lines.join('\n');
}

/**
 * Register the FileMaker: Show Diagnostics command.
 *
 * Opens a new untitled markdown document with the diagnostic report.
 */
export function registerShowDiagnosticsCommand(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand('filemakerDataApiTools.showDiagnostics', async () => {
    try {
      const report = await buildDiagnosticReport(context);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown'
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to build diagnostic report: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}
