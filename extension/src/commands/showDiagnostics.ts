import * as os from 'node:os';

import * as vscode from 'vscode';

import { localize } from '../i18n';

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
export async function buildDiagnosticReport(context: vscode.ExtensionContext): Promise<string> {
  const lines: string[] = [];
  const push = (text: string) => lines.push(text);

  // Header ---------------------------------------------------------------
  push(
    localize(
      'commands.showDiagnostics.report.title',
      '# FileMaker Data API Tools - Diagnostic Report'
    )
  );
  push('');
  push(
    localize(
      'commands.showDiagnostics.report.redactionIntro',
      '_Paste this into a bug report. Secrets are already redacted; no further redaction needed._'
    )
  );
  push('');
  push(
    localize(
      'commands.showDiagnostics.report.generated',
      'Generated: {0}',
      new Date().toISOString()
    )
  );
  push('');

  // Environment ----------------------------------------------------------
  push(localize('commands.showDiagnostics.report.environment.heading', '## Environment'));
  push('');
  push(localize('commands.showDiagnostics.report.environment.tableHeader', '| Key | Value |'));
  push('| --- | --- |');
  push(
    localize(
      'commands.showDiagnostics.report.environment.vscode',
      '| VS Code version | {0} |',
      vscode.version
    )
  );
  push(
    localize(
      'commands.showDiagnostics.report.environment.extensionVersion',
      '| Extension version | {0} |',
      context.extension.packageJSON.version ??
        localize('commands.showDiagnostics.unknown', 'unknown')
    )
  );
  push(
    localize(
      'commands.showDiagnostics.report.environment.extensionId',
      '| Extension ID | {0} |',
      context.extension.id
    )
  );
  push(
    localize(
      'commands.showDiagnostics.report.environment.extensionMode',
      '| Extension mode | {0} |',
      context.extensionMode === 1
        ? localize('commands.showDiagnostics.mode.production', 'Production')
        : context.extensionMode === 2
          ? localize('commands.showDiagnostics.mode.development', 'Development')
          : localize('commands.showDiagnostics.mode.test', 'Test')
    )
  );
  push(`| OS | ${os.platform()} ${os.release()} (${os.arch()}) |`);
  push(`| Node | ${process.version} |`);
  push(
    localize(
      'commands.showDiagnostics.report.environment.workspaceTrusted',
      '| Workspace trusted | {0} |',
      vscode.workspace.isTrusted
    )
  );
  push('');

  // Active profile (redacted) -------------------------------------------
  push(localize('commands.showDiagnostics.report.activeProfile.heading', '## Active profile'));
  push('');
  const profiles = (context.globalState.get<unknown[]>('filemaker.profiles', []) ?? []) as {
    id?: string;
    name?: string;
  }[];
  const activeProfileId =
    context.workspaceState.get<string>('filemaker.activeProfileId') ??
    context.globalState.get<string>('filemaker.activeProfileId');
  if (!profiles.length) {
    push(localize('commands.showDiagnostics.report.noProfiles', '_No profiles configured._'));
  } else {
    const activeProfile = profiles.find((p) => p?.id === activeProfileId);
    if (activeProfile) {
      push(
        localize(
          'commands.showDiagnostics.report.profileName',
          '- Name: `{0}`',
          activeProfile.name ?? localize('commands.showDiagnostics.unnamed', '(unnamed)')
        )
      );
      push(
        localize(
          'commands.showDiagnostics.report.credentialsRedacted',
          '- Credentials: **redacted** (stored in OS keychain / SecretStorage)'
        )
      );
      push(
        localize(
          'commands.showDiagnostics.report.serverUrlRedacted',
          '- Server URL: **redacted** (treated as semi-sensitive)'
        )
      );
    } else {
      push(
        localize(
          'commands.showDiagnostics.report.noActiveProfile',
          '_{0} profile(s) configured; none currently active._',
          profiles.length
        )
      );
    }
  }
  push('');

  // Settings -------------------------------------------------------------
  push(localize('commands.showDiagnostics.report.settings.heading', '## Settings (filemaker.*)'));
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
    'schema.hashAlgorithm'
  ];
  for (const key of settingsKeys) {
    const value = config.get(key);
    push(`  "filemaker.${key}": ${JSON.stringify(value)},`);
  }
  push('```');
  push('');

  // Recent log entries placeholder --------------------------------------
  push(localize('commands.showDiagnostics.report.logs.heading', '## Recent log entries'));
  push('');
  push(
    localize(
      'commands.showDiagnostics.report.logs.instructions',
      '_Run **FileMaker: Open Output Panel** to see the live log. VS Code does not expose the OutputChannel buffer to extensions; copy the panel content manually if relevant to the bug._'
    )
  );
  push('');

  // Footer ---------------------------------------------------------------
  push('---');
  push('');
  push(
    localize(
      'commands.showDiagnostics.report.excluded.heading',
      '**What is NOT in this report (because we never store / never log it):**'
    )
  );
  push(
    localize('commands.showDiagnostics.report.excluded.serverUrl', '- Your FileMaker server URL')
  );
  push(
    localize(
      'commands.showDiagnostics.report.excluded.credentials',
      '- Your username, password, or session token'
    )
  );
  push(
    localize(
      'commands.showDiagnostics.report.excluded.schemaNames',
      '- Layout / table / field names from your database'
    )
  );
  push(
    localize(
      'commands.showDiagnostics.report.excluded.payloads',
      '- Query payloads or response data'
    )
  );
  push('');
  push(
    localize(
      'commands.showDiagnostics.report.manualAddition',
      'If you want to include any of those, add them MANUALLY after pasting this report - and double-check the redaction.'
    )
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
        localize(
          'commands.showDiagnostics.failed',
          'Failed to build diagnostic report: {0}',
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  });
}
