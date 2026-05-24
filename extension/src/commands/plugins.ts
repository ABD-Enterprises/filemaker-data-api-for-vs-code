import * as vscode from 'vscode';

import { localize } from '../i18n';
import type { PluginRegistry } from '../plugins/pluginRegistry';

interface RegisterPluginCommandsDeps {
  pluginRegistry: PluginRegistry;
}

export function registerPluginCommands(deps: RegisterPluginCommandsDeps): vscode.Disposable[] {
  const { pluginRegistry } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.reloadPlugins', async () => {
      await pluginRegistry.reload();
      vscode.window.showInformationMessage(
        localize('commands.plugins.reloaded', 'Reloaded FileMaker plugins.')
      );
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.listActivePlugins', async () => {
      const active = pluginRegistry.listActivePlugins();
      if (active.length === 0) {
        vscode.window.showInformationMessage(
          localize('commands.plugins.noneActive', 'No active FileMaker plugins.')
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        active.map((plugin) => ({
          label: plugin.name,
          description: `${plugin.source} • commands: ${plugin.commandCount}`,
          detail: `id=${plugin.id} • treeProviders=${plugin.treeProviderCount}`,
          plugin
        })),
        {
          title: localize('commands.plugins.active.title', 'Active FileMaker Plugins')
        }
      );

      if (!picked) {
        return;
      }

      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(picked.plugin, null, 2)
      });

      await vscode.window.showTextDocument(document, { preview: false });
    })
  ];
}
