import * as vscode from 'vscode';

import type { HistoryStore } from '../services/historyStore';

interface RegisterHistoryCommandDeps {
  historyStore: HistoryStore;
}

export function registerHistoryCommands(deps: RegisterHistoryCommandDeps): vscode.Disposable[] {
  const { historyStore } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.showRequestHistory', async () => {
      const entries = historyStore.listEntries();

      if (entries.length === 0) {
        vscode.window.showInformationMessage('No request history entries available yet.');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: `${entry.success ? '✓' : '✗'} ${entry.operation}`,
          detail: `${entry.profileId}${entry.layout ? ` • ${entry.layout}` : ''}`,
          description: `${entry.durationMs}ms • ${entry.timestamp}`,
          entry
        })),
        {
          title: 'Request History',
          placeHolder: 'Select an entry to inspect details'
        }
      );

      if (!selected) {
        return;
      }

      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(selected.entry, null, 2)
      });

      await vscode.window.showTextDocument(doc, {
        preview: false
      });
    })
  ];
}
