import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { LayoutInspectorProvider } from '../views/layoutInspector';
import { parseLayoutArg, promptForLayout, resolveProfileFromArg, showCommandError } from './common';

interface RegisterLayoutInspectorCommandDeps {
  profileStore: ProfileStore;
  fmClient: FMClient;
  layoutInspectorProvider: LayoutInspectorProvider;
  logger: Logger;
}

export function registerLayoutInspectorCommands(
  deps: RegisterLayoutInspectorCommandDeps
): vscode.Disposable[] {
  const { profileStore, fmClient, layoutInspectorProvider, logger } = deps;

  return [
    vscode.commands.registerCommand(
      'filemakerDataApiTools.selectLayoutForInspector',
      async (arg: unknown) => {
        const contextArg = parseLayoutArg(arg);
        const profile = await resolveProfileFromArg(contextArg, profileStore, true);

        if (!profile) {
          return;
        }

        const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
        if (!layout) {
          return;
        }

        layoutInspectorProvider.selectLayout(profile.id, layout);
        await vscode.commands.executeCommand('filemakerLayoutInspector.focus');
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.refreshLayoutInspector', async () => {
      try {
        await layoutInspectorProvider.refreshCurrent();
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to refresh Layout Inspector.',
          logger,
          logMessage: 'Layout Inspector refresh failed.'
        });
      }
    })
  ];
}
