import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import { localize } from '../i18n';
import { parseLayoutArg, pickProfile, promptForLayout } from './common';
import { ScriptRunnerPanel } from '../webviews/scriptRunner';

interface RegisterScriptRunnerCommandDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  fmClient: FMClient;
  roleGuard: RoleGuard;
  logger: Logger;
}

export function registerScriptRunnerCommands(
  deps: RegisterScriptRunnerCommandDeps
): vscode.Disposable[] {
  const { context, profileStore, fmClient, roleGuard, logger } = deps;

  return [
    vscode.commands.registerCommand(
      'filemakerDataApiTools.openScriptRunner',
      async (arg: unknown) => {
        if (
          !(await roleGuard.assertFeature(
            'scriptRunner',
            localize('commands.scriptRunner.open.featureName', 'Open Script Runner')
          ))
        ) {
          return;
        }

        const contextArg = parseLayoutArg(arg);

        let profileId = contextArg.profileId;
        let layout = contextArg.layout;
        let recordId: string | undefined;

        if (!profileId) {
          const profile = await pickProfile(profileStore, true);
          if (!profile) {
            return;
          }

          profileId = profile.id;
        }

        if (!layout) {
          const profile = await profileStore.getProfile(profileId);
          if (!profile) {
            vscode.window.showErrorMessage(
              localize(
                'commands.scriptRunner.selectedProfileNotFound',
                'Selected profile not found.'
              )
            );
            return;
          }

          layout = await promptForLayout(profile, fmClient);
        }

        if (layout) {
          const inputRecordId = await vscode.window.showInputBox({
            title: localize('commands.scriptRunner.open.title', 'Script Runner'),
            prompt: localize('commands.scriptRunner.open.recordIdPrompt', 'Record ID (optional)'),
            ignoreFocusOut: true
          });

          recordId = inputRecordId?.trim() || undefined;
        }

        ScriptRunnerPanel.createOrShow(context, profileStore, fmClient, logger, {
          profileId,
          layout,
          recordId
        });
      }
    )
  ];
}
