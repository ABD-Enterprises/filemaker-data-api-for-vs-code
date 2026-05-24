import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
import type { SettingsService } from '../services/settingsService';
import { localize } from '../i18n';
import { validateRecordId } from '../utils/jsonValidate';
import { parseLayoutArg, pickProfile, promptForLayout, showCommandError } from './common';
import { RecordEditorPanel } from '../webviews/recordEditor';

interface RegisterRecordEditCommandsDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  fmClient: FMClient;
  schemaService: SchemaService;
  settingsService: SettingsService;
  roleGuard: RoleGuard;
  logger: Logger;
}

export function registerRecordEditCommands(
  deps: RegisterRecordEditCommandsDeps
): vscode.Disposable[] {
  const { context, profileStore, fmClient, schemaService, settingsService, roleGuard, logger } =
    deps;

  return [
    vscode.commands.registerCommand(
      'filemakerDataApiTools.openRecordEditor',
      async (arg: unknown) => {
        if (!settingsService.isRecordEditEnabled()) {
          vscode.window.showInformationMessage(
            localize('commands.recordEdit.disabled', 'Record editing is disabled by settings.')
          );
          return;
        }
        if (
          !(await roleGuard.assertFeature(
            'recordEdit',
            localize('commands.recordEdit.open.featureName', 'Open Record Editor')
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
              localize('commands.recordEdit.selectedProfileNotFound', 'Selected profile not found.')
            );
            return;
          }

          layout = await promptForLayout(profile, fmClient);
        }

        if (layout) {
          const enteredRecordId = await vscode.window.showInputBox({
            title: localize('commands.recordEdit.open.title', 'Open Record Editor'),
            prompt: localize('commands.recordEdit.open.recordIdPrompt', 'Record ID (optional)'),
            ignoreFocusOut: true
          });
          recordId = enteredRecordId?.trim() || undefined;
        }

        RecordEditorPanel.createOrShow(context, profileStore, fmClient, schemaService, logger, {
          profileId,
          layout,
          recordId
        });
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.editRecordById',
      async (arg: unknown) => {
        if (!settingsService.isRecordEditEnabled()) {
          vscode.window.showInformationMessage(
            localize('commands.recordEdit.disabled', 'Record editing is disabled by settings.')
          );
          return;
        }
        if (
          !(await roleGuard.assertFeature(
            'recordEdit',
            localize('commands.recordEdit.editById.featureName', 'Edit Record by ID')
          ))
        ) {
          return;
        }

        const contextArg = parseLayoutArg(arg);
        let profileId = contextArg.profileId;
        let layout = contextArg.layout;

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
              localize('commands.recordEdit.selectedProfileNotFound', 'Selected profile not found.')
            );
            return;
          }
          layout = await promptForLayout(profile, fmClient);
        }

        if (!layout) {
          return;
        }

        const recordId = await vscode.window.showInputBox({
          title: localize('commands.recordEdit.editById.title', 'Edit Record by ID'),
          prompt: localize('commands.recordEdit.editById.recordIdPrompt', 'Record ID'),
          ignoreFocusOut: true,
          validateInput: (value) => validateRecordId(value).error
        });

        if (!recordId) {
          return;
        }

        RecordEditorPanel.createOrShow(context, profileStore, fmClient, schemaService, logger, {
          profileId,
          layout,
          recordId: recordId.trim()
        });
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.createRecord', async (arg: unknown) => {
      if (!settingsService.isRecordEditEnabled()) {
        vscode.window.showInformationMessage(
          localize('commands.recordEdit.disabled', 'Record editing is disabled by settings.')
        );
        return;
      }
      if (
        !(await roleGuard.assertFeature(
          'recordEdit',
          localize('commands.recordEdit.create.featureName', 'Create Record')
        ))
      ) {
        return;
      }

      const contextArg = parseLayoutArg(arg);
      let profileId = contextArg.profileId;
      let layout = contextArg.layout;

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
            localize('commands.recordEdit.selectedProfileNotFound', 'Selected profile not found.')
          );
          return;
        }
        layout = await promptForLayout(profile, fmClient);
      }

      if (!layout) {
        return;
      }

      RecordEditorPanel.createOrShow(context, profileStore, fmClient, schemaService, logger, {
        profileId,
        layout,
        mode: 'create'
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.deleteRecord', async (arg: unknown) => {
      if (
        !(await roleGuard.assertFeature(
          'writeOperations',
          localize('commands.recordEdit.delete.featureName', 'Delete Record')
        ))
      ) {
        return;
      }
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          localize(
            'commands.recordEdit.delete.untrusted',
            'Delete Record is disabled in untrusted workspaces.'
          )
        );
        return;
      }

      const contextArg = parseLayoutArg(arg);
      let profileId = contextArg.profileId;
      let layout = contextArg.layout;

      if (!profileId) {
        const profile = await pickProfile(profileStore, true);
        if (!profile) {
          return;
        }
        profileId = profile.id;
      }

      const profile = await profileStore.getProfile(profileId);
      if (!profile) {
        vscode.window.showErrorMessage(
          localize('commands.recordEdit.selectedProfileNotFound', 'Selected profile not found.')
        );
        return;
      }

      if (!layout) {
        layout = await promptForLayout(profile, fmClient);
      }

      if (!layout) {
        return;
      }

      const recordId = await vscode.window.showInputBox({
        title: localize('commands.recordEdit.delete.title', 'Delete Record'),
        prompt: localize(
          'commands.recordEdit.delete.recordIdPrompt',
          'Enter the record ID to delete'
        ),
        ignoreFocusOut: true,
        validateInput: (value) => validateRecordId(value).error
      });

      if (!recordId) {
        return;
      }

      const deleteLabel = localize('commands.recordEdit.delete.action', 'Delete');
      const confirmation = await vscode.window.showWarningMessage(
        localize(
          'commands.recordEdit.delete.confirm',
          'Delete record {0} from layout "{1}"? This cannot be undone.',
          recordId.trim(),
          layout
        ),
        { modal: true },
        deleteLabel
      );

      if (confirmation !== deleteLabel) {
        return;
      }

      try {
        const result = await fmClient.deleteRecord(profile, layout, recordId.trim());
        vscode.window.showInformationMessage(
          localize(
            'commands.recordEdit.delete.success',
            'Record {0} deleted from "{1}".',
            result.recordId,
            layout
          )
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: localize(
            'commands.recordEdit.delete.failed',
            'Failed to delete record.'
          ),
          logger,
          logMessage: 'Delete record command failed.'
        });
      }
    })
  ];
}
