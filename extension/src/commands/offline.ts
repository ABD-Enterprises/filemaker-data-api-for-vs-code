import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { OfflineModeService } from '../offline/offlineModeService';
import { localize } from '../i18n';
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
      const enabled = await offlineModeService.toggleOfflineMode();
      await roleGuard.applyContexts();
      refreshExplorer();
      vscode.window.showInformationMessage(
        localize(
          'commands.offline.toggle.success',
          'Offline mode {0}.',
          enabled
            ? localize('commands.offline.toggle.enabled', 'enabled')
            : localize('commands.offline.toggle.disabled', 'disabled')
        )
      );
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.refreshOfflineCache',
      async (arg: unknown) => {
        const profile = await resolveProfileFromArg(arg, profileStore, true);
        if (!profile) {
          return;
        }

        if (!vscode.workspace.isTrusted) {
          vscode.window.showWarningMessage(
            localize(
              'commands.offline.refresh.untrusted',
              'Workspace is untrusted. Offline cache refresh is disabled.'
            )
          );
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
            localize(
              'commands.offline.refresh.success',
              'Offline metadata cache refreshed for {0}. Cached={1}, failed={2}.',
              profile.name,
              result.cached,
              result.failed
            )
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.offline.refresh.failed',
              'Failed to refresh offline cache.'
            ),
            logger,
            logMessage: 'Failed to refresh offline cache.'
          });
        }
      }
    )
  ];
}
