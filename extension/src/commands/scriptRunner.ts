import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import { resolveLayoutContext } from './common';
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
    vscode.commands.registerCommand('filemakerDataApiTools.openScriptRunner', async (arg: unknown) => {
      if (!(await roleGuard.assertFeature('scriptRunner', 'Open Script Runner'))) {
        return;
      }

      const selection = await resolveLayoutContext(arg, profileStore, fmClient);
      if (!selection) {
        return;
      }
      const { profile, layout } = selection;
      const profileId = profile.id;

      const inputRecordId = await vscode.window.showInputBox({
        title: 'Script Runner',
        prompt: 'Record ID (optional; leave blank for no record context)',
        ignoreFocusOut: true
      });
      if (inputRecordId === undefined) {
        return;
      }
      const recordId = inputRecordId.trim() || undefined;

      ScriptRunnerPanel.createOrShow(context, profileStore, fmClient, logger, {
        profileId,
        layout,
        recordId
      });
    })
  ];
}
