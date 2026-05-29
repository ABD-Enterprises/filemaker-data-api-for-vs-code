import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
import type { SettingsService } from '../services/settingsService';
import { validateRecordId } from '../utils/jsonValidate';
import { readContainerUploadFile } from '../utils/containerUpload';
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

interface ContainerUploadCommandArg {
  profileId?: string;
  layout?: string;
  layoutName?: string;
  recordId?: string;
  fieldName?: string;
  fieldRepetition?: number;
  modId?: string;
}

export function registerRecordEditCommands(deps: RegisterRecordEditCommandsDeps): vscode.Disposable[] {
  const { context, profileStore, fmClient, schemaService, settingsService, roleGuard, logger } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.openRecordEditor', async (arg: unknown) => {
      if (!settingsService.isRecordEditEnabled()) {
        vscode.window.showInformationMessage('Record editing is disabled by settings.');
        return;
      }
      if (!(await roleGuard.assertFeature('recordEdit', 'Open Record Editor'))) {
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
          vscode.window.showErrorMessage('Selected profile not found.');
          return;
        }

        layout = await promptForLayout(profile, fmClient);
      }

      if (layout) {
        const enteredRecordId = await vscode.window.showInputBox({
          title: 'Open Record Editor',
          prompt: 'Record ID (optional)',
          ignoreFocusOut: true
        });
        recordId = enteredRecordId?.trim() || undefined;
      }

      RecordEditorPanel.createOrShow(context, profileStore, fmClient, schemaService, logger, {
        profileId,
        layout,
        recordId
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.editRecordById', async (arg: unknown) => {
      if (!settingsService.isRecordEditEnabled()) {
        vscode.window.showInformationMessage('Record editing is disabled by settings.');
        return;
      }
      if (!(await roleGuard.assertFeature('recordEdit', 'Edit Record by ID'))) {
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
          vscode.window.showErrorMessage('Selected profile not found.');
          return;
        }
        layout = await promptForLayout(profile, fmClient);
      }

      if (!layout) {
        return;
      }

      const recordId = await vscode.window.showInputBox({
        title: 'Edit Record by ID',
        prompt: 'Record ID',
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
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.createRecord', async (arg: unknown) => {
      if (!settingsService.isRecordEditEnabled()) {
        vscode.window.showInformationMessage('Record editing is disabled by settings.');
        return;
      }
      if (!(await roleGuard.assertFeature('recordEdit', 'Create Record'))) {
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
          vscode.window.showErrorMessage('Selected profile not found.');
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
      if (!(await roleGuard.assertFeature('writeOperations', 'Delete Record'))) {
        return;
      }
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Delete Record is disabled in untrusted workspaces.');
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
        vscode.window.showErrorMessage('Selected profile not found.');
        return;
      }

      if (!layout) {
        layout = await promptForLayout(profile, fmClient);
      }

      if (!layout) {
        return;
      }

      const recordId = await vscode.window.showInputBox({
        title: 'Delete Record',
        prompt: 'Enter the record ID to delete',
        ignoreFocusOut: true,
        validateInput: (value) => validateRecordId(value).error
      });

      if (!recordId) {
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Delete record ${recordId.trim()} from layout "${layout}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );

      if (confirmation !== 'Delete') {
        return;
      }

      try {
        const result = await fmClient.deleteRecord(profile, layout, recordId.trim());
        vscode.window.showInformationMessage(
          `Record ${result.recordId} deleted from "${layout}".`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to delete record.',
          logger,
          logMessage: 'Delete record command failed.'
        });
      }
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.uploadContainer',
      async (arg: unknown) => {
        if (!settingsService.isRecordEditEnabled()) {
          vscode.window.showInformationMessage('Record editing is disabled by settings.');
          return false;
        }
        if (!(await roleGuard.assertFeature('recordEdit', 'Upload to Container'))) {
          return false;
        }
        if (!vscode.workspace.isTrusted) {
          vscode.window.showWarningMessage(
            'Upload to Container is disabled in untrusted workspaces.'
          );
          return false;
        }

        const contextArg = parseContainerUploadArg(arg);
        let profileId = contextArg.profileId;
        let layout = contextArg.layout;

        if (!profileId) {
          const profile = await pickProfile(profileStore, true);
          if (!profile) {
            return false;
          }
          profileId = profile.id;
        }

        const profile = await profileStore.getProfile(profileId);
        if (!profile) {
          vscode.window.showErrorMessage('Selected profile not found.');
          return false;
        }

        if (!layout) {
          layout = await promptForLayout(profile, fmClient);
        }

        if (!layout) {
          return false;
        }

        const recordId = contextArg.recordId ?? (await promptForRecordId());
        if (!recordId) {
          return false;
        }

        const fieldName = contextArg.fieldName ?? (await promptForContainerFieldName());
        if (!fieldName) {
          return false;
        }

        const selection = await vscode.window.showOpenDialog({
          title: 'Select File to Upload',
          openLabel: 'Upload',
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false
        });

        const uri = selection?.[0];
        if (!uri) {
          return false;
        }

        try {
          const maxBytes = settingsService.getContainerUploadMaxBytes();
          const file = await readContainerUploadFile(uri, maxBytes);
          const result = await fmClient.uploadContainer(
            profile,
            layout,
            recordId.trim(),
            fieldName.trim(),
            file,
            {
              fieldRepetition: contextArg.fieldRepetition,
              modId: contextArg.modId,
              maxBytes
            }
          );

          vscode.window.showInformationMessage(
            `Uploaded "${file.fileName}" to ${fieldName.trim()} on record ${result.recordId}.`
          );
          return true;
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: 'Failed to upload file to container field.',
            logger,
            logMessage: 'Upload container command failed.',
            actions: {
              settingsKey: 'filemaker.containerUploadMaxBytes'
            }
          });
          return false;
        }
      }
    )
  ];
}

function parseContainerUploadArg(arg: unknown): ContainerUploadCommandArg {
  const layoutArg = parseLayoutArg(arg);
  if (!arg || typeof arg !== 'object') {
    return layoutArg;
  }

  const value = arg as ContainerUploadCommandArg;
  return {
    ...layoutArg,
    recordId: typeof value.recordId === 'string' ? value.recordId : undefined,
    fieldName: typeof value.fieldName === 'string' ? value.fieldName : undefined,
    fieldRepetition: typeof value.fieldRepetition === 'number' ? value.fieldRepetition : undefined,
    modId: typeof value.modId === 'string' ? value.modId : undefined
  };
}

async function promptForRecordId(): Promise<string | undefined> {
  const recordId = await vscode.window.showInputBox({
    title: 'Upload to Container',
    prompt: 'Enter the FileMaker record ID',
    ignoreFocusOut: true,
    validateInput: (value) => validateRecordId(value).error
  });

  return recordId?.trim() || undefined;
}

async function promptForContainerFieldName(): Promise<string | undefined> {
  const fieldName = await vscode.window.showInputBox({
    title: 'Upload to Container',
    prompt: 'Enter the container field name',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? 'Container field name is required.' : undefined
  });

  return fieldName?.trim() || undefined;
}
