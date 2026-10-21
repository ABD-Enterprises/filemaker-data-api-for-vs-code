import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { ProfileStore } from '../services/profileStore';
import type { SecretStore } from '../services/secretStore';
import type { SettingsService } from '../services/settingsService';
import type { Logger } from '../services/logger';
import { testMyServer, renderSelfTestReport } from '../services/serverSelfTest';
import { isFeatureEnabled, isOfflineModeOn } from '../utils/policySetting';
import { redactString } from '../utils/redact';

export const SELF_TEST_NOTICE = 'This will check product info and server version without login, log in with your stored credentials, try the database list, count layouts and scripts, read field details for the first 3 layouts, read at most 1 record with Get records on a layout you choose, get that record, try a no-match find on a text field you choose, log out and check that the old session is refused. It never prints passwords or tokens, record values or script results. It does not test containers or batches. It changes no data unless you choose the write test and confirm a SCRATCH layout in a second dialog. That test creates, gets, edits, tries a stale edit and deletes one test record, with cleanup if a step fails. Scripts are skipped unless you type a name and parameter and confirm; a script may change data. Cancel stops further tests; cleanup and logout are still attempted. Use a test file: server-side triggers and automatic fields can have effects even when reading.';

export function registerTestMyServerCommand(deps: {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  secretStore: SecretStore;
  settingsService: SettingsService;
  roleGuard: RoleGuard;
  logger: Logger;
}): vscode.Disposable {
  return vscode.commands.registerCommand('filemakerDataApiTools.testMyServer', async () => {
    const { context, profileStore, secretStore, settingsService, roleGuard, logger } = deps;
    const allowed = (kind: 'read' | 'write' | 'script') => {
      const config = vscode.workspace.getConfiguration('filemaker');
      if (isOfflineModeOn(config)) return false;
      if (kind === 'read') return true;
      if (!vscode.workspace.isTrusted) return false;
      return kind === 'write'
        ? isFeatureEnabled(config, 'features.recordEdit.enabled') && roleGuard.getFeatureGuard('recordEdit').allowed && roleGuard.getFeatureGuard('writeOperations').allowed
        : isFeatureEnabled(config, 'features.scriptRunner.enabled') && roleGuard.getFeatureGuard('scriptRunner').allowed;
    };
    if (!allowed('read')) {
      await vscode.window.showInformationMessage('Test My Server needs a connection. Turn off offline mode first.');
      return;
    }
    const id = profileStore.getActiveProfileId();
    const profile = id ? await profileStore.getProfile(id) : undefined;
    if (!profile) {
      await vscode.window.showInformationMessage('Choose an active FileMaker connection first.');
      return;
    }
    try {
      const { createSelfTestClient } = await import('../services/serverSelfTestClient');
      const client = await createSelfTestClient(profile, secretStore, logger, settingsService.getRequestTimeoutMs());
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'FileMaker: Test My Server', cancellable: true }, async (progress, cancellation) => {
        const controller = new AbortController();
        if (cancellation.isCancellationRequested) controller.abort();
        const subscription = cancellation.onCancellationRequested(() => controller.abort());
        try {
          return await testMyServer(client, profile, {
            start: async () => {
              const answer = await vscode.window.showWarningMessage(SELF_TEST_NOTICE, { modal: true }, 'Run read-only test', ...(allowed('write') ? ['Also run the write test'] : []));
              return answer === 'Also run the write test' ? 'write' : answer === 'Run read-only test' ? 'read' : undefined;
            },
            pickLayout: async (layouts, scratch) => {
              const lastKey = `filemakerDataApiTools.selfTest.layout.${profile.id}`;
              const last = context.workspaceState.get<string>(lastKey);
              const items = layouts.map((label) => ({ label, description: !scratch && label === last ? 'Last choice' : undefined }));
              if (!scratch) items.sort((a, b) => Number(b.label === last) - Number(a.label === last));
              const choice = await vscode.window.showQuickPick(items, { title: scratch ? 'Choose a SCRATCH layout (only disposable test data)' : 'Choose a layout to read a record', ignoreFocusOut: true });
              if (choice && !scratch) await context.workspaceState.update(lastKey, choice.label);
              return choice?.label;
            },
            pickField: async (fields, scratch) => fields.length ? vscode.window.showQuickPick(fields, { title: scratch ? 'Choose an editable text field for the test record' : 'Choose a text field for the no-match find', ignoreFocusOut: true }) : undefined,
            confirmWrite: async (layout) => await vscode.window.showWarningMessage(`SCRATCH layout "${layout}": one test record will be created, read, edited and deleted. A stale edit will also be tried. Automatic fields and server triggers may run. Use only a disposable test layout.`, { modal: true }, 'Create, edit and delete one test record') === 'Create, edit and delete one test record',
            script: async () => {
              const name = await vscode.window.showInputBox({ title: 'Optional script test', prompt: 'Skip by leaving blank. Otherwise type the exact script name. Scripts may change data.' });
              if (name === undefined || name === '') return undefined;
              const parameter = await vscode.window.showInputBox({ title: 'Optional script parameter', prompt: 'Type the parameter (blank is allowed). It will not appear in the report.' });
              return parameter === undefined ? undefined : { name, parameter };
            },
            confirmScript: async (name) => await vscode.window.showWarningMessage(`Run script "${name}" with the parameter you entered? It may change data or have other effects.`, { modal: true }, 'Run this script') === 'Run this script',
            allowed,
            progress: (message) => progress.report({ message: redactString(client.scrub(message)) })
          }, controller.signal);
        } finally { subscription.dispose(); }
      });
      if (!report) return;
      const content = renderSelfTestReport(report);
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      await vscode.window.showTextDocument(document);
      const copy = await vscode.window.showInformationMessage('Server test report is ready. Review it before sharing.', 'Copy report', 'Copy report with server address hidden');
      if (copy) await vscode.env.clipboard.writeText(renderSelfTestReport(report, copy === 'Copy report with server address hidden'));
    } catch {
      await vscode.window.showErrorMessage('Test My Server could not finish. Check the active connection and try again.');
    }
  });
}
