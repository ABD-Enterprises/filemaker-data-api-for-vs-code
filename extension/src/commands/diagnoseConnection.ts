import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import { buildDiagnosticReport, createDiagnosticProbes, runConnectionDiagnostics, type DiagnosticReport } from '../services/connectionDiagnostics';
import type { FMClient } from '../services/fmClient';
import type { ProfileStore } from '../services/profileStore';
import { installAgentReplacedPolicy } from '../services/proxySupport';
import { setSystemCertificatePolicy, hostReplacesAgentFor } from '../services/tlsAgent';
import type { ConnectionProfile } from '../types/fm';
import { redactString } from '../utils/redact';
import { parseProfileId } from './common';

interface DiagnosticCommandDeps { profileStore: ProfileStore; fmClient: FMClient; roleGuard: RoleGuard }

export function registerConnectionDiagnosticCommands(deps: DiagnosticCommandDeps): vscode.Disposable[] {
  let latest: DiagnosticReport | undefined;
  const copy = async () => {
    if (!latest) { await vscode.window.showInformationMessage('Run FileMaker: Diagnose Connection first.'); return; }
    const choice = await vscode.window.showQuickPick(['Yes, hide it', 'No, include it'], { title: 'Hide the server address?' });
    if (!choice) return;
    await vscode.env.clipboard.writeText(buildDiagnosticReport(latest, choice === 'Yes, hide it'));
    await vscode.window.showInformationMessage('Connection diagnosis copied for your bug report.');
  };
  return [
    vscode.commands.registerCommand('filemakerDataApiTools.copyConnectionDiagnosis', copy),
    vscode.commands.registerCommand('filemakerDataApiTools.diagnoseConnection', async (arg: unknown) => {
      try {
        // This is read-only: Connect and the wizard do not gate it on writeOperations.
        // Offline mode is still respected before even a DNS lookup.
        if (deps.roleGuard.isOfflineModeEnabled()) {
          await vscode.window.showWarningMessage('Offline mode is enabled. Turn it off before diagnosing a connection.');
          return;
        }
        const profiles = await deps.profileStore.listProfiles();
        const id = parseProfileId(arg) ?? deps.profileStore.getActiveProfileId();
        let profile = profiles.find((entry) => entry.id === id);
        const chooseTarget = async (): Promise<ConnectionProfile | undefined> => {
          const picked = await vscode.window.showQuickPick([
            ...profiles.map((entry) => ({ label: entry.name, profile: entry })),
            { label: 'Type a server address (without saving)', profile: undefined }
          ], { title: 'Diagnose Connection', placeHolder: 'Choose a profile or type an address for a quick check' });
          if (!picked) return undefined;
          if (picked.profile) return picked.profile;
          const address = await vscode.window.showInputBox({ title: 'Server address (not saved)', prompt: 'Enter https:// followed by the FileMaker Server host name and optional port.', placeHolder: 'https://fm.example.com' });
          return address === undefined ? undefined : { id: 'connection-diagnosis', name: 'Quick check', serverUrl: address, database: '', authMode: 'direct' };
        };
        if (profile) {
          const choice = await vscode.window.showQuickPick(['Diagnose active profile', 'Choose another profile or type an address'], { title: 'Diagnose Connection' });
          if (!choice) return;
          if (choice !== 'Diagnose active profile') profile = await chooseTarget();
        } else profile = await chooseTarget();
        if (!profile) return;
        // Like Connect, use user-confirmed saved profiles. A typed check never loads a workspace template.
        // Recheck after the user dialogs, since settings can change while they are open.
        if (deps.roleGuard.isOfflineModeEnabled()) return;
        const target = profile;
        installAgentReplacedPolicy();
        // Diagnosis can run before the lazy client has installed this same policy.
        setSystemCertificatePolicy(() => vscode.workspace.getConfiguration('http').get<boolean>('systemCertificates', true));
        const http = vscode.workspace.getConfiguration('http');
        latest = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'FileMaker: Diagnose Connection', cancellable: true }, async (progress, token) => {
          const controller = new AbortController();
          const listener = token.onCancellationRequested(() => controller.abort());
          if (token.isCancellationRequested) controller.abort();
          try {
            progress.report({ message: 'Checking address, DNS, port, certificate and Data API…' });
            return await runConnectionDiagnostics(target, {
              proxySupport: http.get<string>('proxySupport', 'override'),
              proxyConfigured: Boolean(http.get<string>('proxy', '')),
              systemCertificates: http.get<boolean>('systemCertificates', true),
              proxyVariables: ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'].filter((key) => Boolean(process.env[key])),
              hostReplaced: hostReplacesAgentFor(target.serverUrl)
            }, createDiagnosticProbes(deps.fmClient), controller.signal);
          } finally { listener.dispose(); }
        });
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: buildDiagnosticReport(latest) });
        await vscode.window.showTextDocument(document, { preview: false });
        const action = await vscode.window.showInformationMessage('Connection diagnosis is ready.', 'Copy for bug report');
        if (action) await copy();
      } catch {
        await vscode.window.showErrorMessage(redactString('Connection diagnosis could not finish. Run it again, or use FileMaker: Show Diagnostics.'));
      }
    })
  ];
}
