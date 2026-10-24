import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { OfflineModeService } from '../offline/offlineModeService';
import { resolveProfileFromArg, showCommandError } from './common';

interface RegisterOfflineCommandsDeps {
  profileStore: ProfileStore;
  fmClient: FMClient;
  offlineModeService: OfflineModeService;
  roleGuard: RoleGuard;
  logger: Logger;
  refreshExplorer: () => void;
}

export function registerOfflineCommands(deps: RegisterOfflineCommandsDeps): vscode.Disposable[] {
  const { profileStore, fmClient, offlineModeService, roleGuard, logger, refreshExplorer } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.toggleOfflineMode', async () => {
      try {
        const result = await offlineModeService.toggleOfflineMode();
        await roleGuard.applyContexts();
        refreshExplorer();
        // Report the mode that is really in effect: a workspace setting can keep it on.
        vscode.window.showInformationMessage(
          result.effective
            ? result.keptOnBy
              ? `Offline mode is still on because of ${result.keptOnBy}. Your own setting is off; change it there to turn offline mode off.`
              : 'Offline mode enabled.'
            : 'Offline mode disabled.'
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to change offline mode.',
          logger,
          logMessage: 'Toggle offline mode failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.refreshOfflineCache', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore, true);
      if (!profile) {
        return;
      }

      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Workspace is untrusted. Offline cache refresh is disabled.');
        return;
      }

      try {
        const result = await offlineModeService.refreshCache(
          profile,
          async () => fmClient.listLayouts(profile),
          async (layout) => fmClient.getLayoutMetadata(profile, layout)
        );

        refreshExplorer();

        vscode.window.showInformationMessage(
          `Offline metadata cache refreshed for ${profile.name}. Cached=${result.cached}, failed=${result.failed}.`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to refresh offline cache.',
          logger,
          logMessage: 'Failed to refresh offline cache.'
        });
      }
    })
  ];
}
