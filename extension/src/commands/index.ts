import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SavedQueriesStore } from '../services/savedQueriesStore';
import type { SecretStore } from '../services/secretStore';
import type { FindRecordsRequest } from '../types/fm';
import {
  parseFindJson,
  parseOptionalNonNegativeInteger,
  parseSortJson,
  validateRecordId
} from '../utils/jsonValidate';
import {
  openJsonDocument,
  parseLayoutArg,
  parseRecordArg,
  promptForLayout,
  resolveProfileFromArg,
  showCommandError
} from './common';
import { ConnectionWizardPanel } from '../webviews/connectionWizard';
import { QueryBuilderPanel } from '../webviews/queryBuilder';
import { RecordViewerPanel } from '../webviews/recordViewer';
import { retryWithBackoff, type BackoffPolicy } from '../utils/backoff';
import { showConnectionQuickPick } from '../views/connectionStatusBar';
import { buildWebDirectRecordUrl, DEFAULT_WEBDIRECT_BASE_PATH } from '../utils/webDirectUrl';

interface RegisterCoreCommandDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  secretStore: SecretStore;
  savedQueriesStore: SavedQueriesStore;
  fmClient: FMClient;
  logger: Logger;
  roleGuard: RoleGuard;
  refreshExplorer: () => void;
  /**
   * Optional callback to re-render the persistent connection status-bar
   * item after any command that changes the active profile (connect /
   * disconnect / remove). Wired in extension.ts; left optional so unit
   * tests don't have to construct a status-bar shim.
   */
  refreshConnectionStatus?: () => void;
  onProfileDisconnected?: (profileId: string) => void;
  /** Resolved at call time so settings updates are picked up live. */
  getConnectBackoffPolicy?: () => BackoffPolicy;
  getConnectionWizardTestPolicy?: () => 'off' | 'warn' | 'block';
  getWebDirectBasePath?: () => string;
}

function isRetryableConnectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: string; status?: number; message?: string };
  if (typeof err.code === 'string') {
    if (
      err.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ENOTFOUND' ||
      err.code === 'EAI_AGAIN' ||
      err.code === 'EPIPE' ||
      err.code === 'ENETUNREACH'
    ) {
      return true;
    }
  }
  if (typeof err.status === 'number' && err.status >= 500 && err.status < 600) {
    return true;
  }
  if (typeof err.message === 'string') {
    if (/timeout|network|socket|reset|refused/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

export function registerCoreCommands(deps: RegisterCoreCommandDeps): vscode.Disposable[] {
  const {
    context,
    profileStore,
    secretStore,
    savedQueriesStore,
    fmClient,
    logger,
    roleGuard,
    refreshExplorer,
    refreshConnectionStatus,
    onProfileDisconnected
  } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.addConnectionProfile', async () => {
      if (!(await roleGuard.assertFeature('writeOperations', 'Add Connection Profile'))) {
        return;
      }

      ConnectionWizardPanel.createOrShow(context, profileStore, secretStore, fmClient, logger, undefined, {
        getTestPolicy: deps.getConnectionWizardTestPolicy
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.editConnectionProfile', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore);
      if (!profile) {
        return;
      }
      if (roleGuard.isProfileLocked(profile.id)) {
        vscode.window.showWarningMessage('This profile is locked by enterprise configuration.');
        return;
      }
      if (!(await roleGuard.assertFeature('writeOperations', 'Edit Connection Profile'))) {
        return;
      }

      ConnectionWizardPanel.createOrShow(context, profileStore, secretStore, fmClient, logger, profile, {
        getTestPolicy: deps.getConnectionWizardTestPolicy
      });
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.removeConnectionProfile',
      async (arg: unknown) => {
        const profile = await resolveProfileFromArg(arg, profileStore);
        if (!profile) {
          return;
        }
        if (roleGuard.isProfileLocked(profile.id)) {
          vscode.window.showWarningMessage('This profile is locked by enterprise configuration.');
          return;
        }
        if (!(await roleGuard.assertFeature('writeOperations', 'Remove Connection Profile'))) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Remove profile "${profile.name}" and all associated secrets?`,
          { modal: true },
          'Remove'
        );

        if (confirmation !== 'Remove') {
          return;
        }

        await profileStore.removeProfile(profile.id);
        await savedQueriesStore.removeQueriesForProfile(profile.id);
        await secretStore.clearProfileSecrets(profile.id);

        fmClient.invalidateProfileCache(profile.id);
        onProfileDisconnected?.(profile.id);

        refreshExplorer();
        refreshConnectionStatus?.();
        vscode.window.showInformationMessage(`Removed profile "${profile.name}".`);
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.connect', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore);
      if (!profile) {
        return;
      }

      const policy: BackoffPolicy = deps.getConnectBackoffPolicy?.() ?? {
        maxRetries: 3,
        initialMs: 1_000,
        maxMs: 30_000,
        multiplier: 2
      };

      const runConnect = async (): Promise<void> => {
        const statusBar = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Left,
          110
        );
        try {
          statusBar.text = `$(sync~spin) FileMaker: Connecting to ${profile.name}…`;
          statusBar.show();

          await retryWithBackoff(
            () => fmClient.createSession(profile),
            policy,
            {
              shouldRetry: (err) => isRetryableConnectError(err),
              onRetry: ({ attempt, delayMs, error }) => {
                const seconds = Math.max(1, Math.round(delayMs / 1000));
                statusBar.text = `$(sync~spin) FileMaker: Connecting to ${profile.name} — retry ${attempt + 1}/${policy.maxRetries} in ${seconds}s`;
                logger.warn('Connect attempt failed; retrying with backoff.', {
                  profileId: profile.id,
                  attempt,
                  delayMs,
                  error
                });
              }
            }
          );

          await profileStore.setActiveProfileId(profile.id);
          refreshExplorer();
          refreshConnectionStatus?.();
          vscode.window.showInformationMessage(`Connected to "${profile.name}".`);
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: 'Failed to connect to FileMaker profile.',
            logger,
            logMessage: 'Connect command failed.',
            actions: {
              retry: runConnect,
              profileId: profile.id,
              settingsKey: 'filemaker.requestTimeoutMs'
            }
          });
        } finally {
          statusBar.dispose();
        }
      };

      await runConnect();
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.openConnectionMenu', async () => {
      // Backing command for the persistent connection status-bar item. Pops a
      // quick-pick of contextual actions (Disconnect / Switch / Open Explorer /
      // Add Profile) and dispatches to the appropriate existing command.
      await showConnectionQuickPick(profileStore);
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.disconnect', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore, true);
      if (!profile) {
        return;
      }

      try {
        await fmClient.deleteSession(profile);

        if (profileStore.getActiveProfileId() === profile.id) {
          await profileStore.setActiveProfileId(undefined);
        }

        onProfileDisconnected?.(profile.id);
        refreshExplorer();
        refreshConnectionStatus?.();
        vscode.window.showInformationMessage(`Disconnected from "${profile.name}".`);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to disconnect from FileMaker profile.',
          logger,
          logMessage: 'Disconnect command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.listLayouts', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore, true);
      if (!profile) {
        return;
      }

      try {
        const layouts = await fmClient.listLayouts(profile);
        await openJsonDocument({
          profile: profile.name,
          database: profile.database,
          layouts
        });
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to list layouts.',
          logger,
          logMessage: 'List layouts command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.runFindJson', async (arg: unknown) => {
      const contextArg = parseLayoutArg(arg);
      const profile = await resolveProfileFromArg(contextArg, profileStore, true);
      if (!profile) {
        return;
      }

      const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
      if (!layout) {
        return;
      }

      const findJsonInput = await vscode.window.showInputBox({
        title: 'Run Find',
        prompt: 'Enter find query JSON array',
        value: '[{}]',
        ignoreFocusOut: true
      });
      if (!findJsonInput) {
        return;
      }

      const sortJsonInput = await vscode.window.showInputBox({
        title: 'Run Find',
        prompt: 'Enter sort JSON array (optional)',
        ignoreFocusOut: true
      });

      const limitInput = await vscode.window.showInputBox({
        title: 'Run Find',
        prompt: 'Enter limit (optional)',
        ignoreFocusOut: true
      });

      const offsetInput = await vscode.window.showInputBox({
        title: 'Run Find',
        prompt: 'Enter offset (optional)',
        ignoreFocusOut: true
      });

      try {
        const findValidation = parseFindJson(findJsonInput);
        if (!findValidation.ok || !findValidation.value) {
          throw new Error(findValidation.error ?? 'Find JSON is invalid.');
        }

        let sortValidationValue: Array<Record<string, unknown>> | undefined;

        if (sortJsonInput && sortJsonInput.trim().length > 0) {
          const sortValidation = parseSortJson(sortJsonInput);
          if (!sortValidation.ok || !sortValidation.value) {
            throw new Error(sortValidation.error ?? 'Sort JSON is invalid.');
          }

          sortValidationValue = sortValidation.value;
        }

        const request: FindRecordsRequest = {
          query: findValidation.value,
          sort: sortValidationValue,
          limit: parseOptionalNonNegativeInteger(limitInput, 'Limit'),
          offset: parseOptionalNonNegativeInteger(offsetInput, 'Offset')
        };

        const result = await fmClient.findRecords(profile, layout, request);
        await openJsonDocument({
          profile: profile.name,
          layout,
          request,
          result
        });
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to run find query.',
          logger,
          logMessage: 'Run find command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.getRecordById', async (arg: unknown) => {
      const contextArg = parseLayoutArg(arg);
      const profile = await resolveProfileFromArg(contextArg, profileStore, true);
      if (!profile) {
        return;
      }

      const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
      if (!layout) {
        return;
      }

      const recordId = await vscode.window.showInputBox({
        title: 'Get Record by ID',
        prompt: 'Enter FileMaker record ID',
        ignoreFocusOut: true,
        validateInput: (value) => validateRecordId(value).error
      });

      if (!recordId) {
        return;
      }

      try {
        const record = await fmClient.getRecord(profile, layout, recordId);
        await openJsonDocument({
          profile: profile.name,
          layout,
          record
        });
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to get record by ID.',
          logger,
          logMessage: 'Get record command failed.'
        });
      }
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.copyWebDirectUrlForCurrentRecord',
      async (arg: unknown) => {
        const contextArg = parseRecordArg(arg);
        const profile = await resolveProfileFromArg(contextArg, profileStore, true);
        if (!profile) {
          return;
        }

        const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
        if (!layout) {
          return;
        }

        const recordId =
          contextArg.recordId ??
          (await vscode.window.showInputBox({
            title: 'Copy WebDirect URL for Current Record',
            prompt: 'Enter FileMaker record ID',
            ignoreFocusOut: true,
            validateInput: (value) => validateRecordId(value).error
          }));
        if (!recordId) {
          return;
        }

        try {
          const url = buildWebDirectRecordUrl({
            profile,
            layout,
            recordId,
            basePath: deps.getWebDirectBasePath?.() ?? DEFAULT_WEBDIRECT_BASE_PATH
          });

          await vscode.env.clipboard.writeText(url);
          const action = await vscode.window.showInformationMessage(
            `WebDirect URL copied: ${url}`,
            'Open in Browser'
          );

          if (action === 'Open in Browser') {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: 'Failed to copy WebDirect URL.',
            logger,
            logMessage: 'Copy WebDirect URL command failed.'
          });
        }
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.openRecordViewer', async (arg: unknown) => {
      const contextArg = parseLayoutArg(arg);

      let profileId = contextArg.profileId;
      let layout = contextArg.layout;
      let recordId: string | undefined;

      if (!profileId) {
        const profile = await resolveProfileFromArg(undefined, profileStore, true);
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
        recordId = await vscode.window.showInputBox({
          title: 'Open Record Viewer',
          prompt: 'Record ID (optional)',
          ignoreFocusOut: true
        });
      }

      RecordViewerPanel.createOrShow(context, profileStore, fmClient, logger, {
        profileId,
        layout,
        recordId
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.openQueryBuilder', async (arg: unknown) => {
      const contextArg = parseLayoutArg(arg);
      QueryBuilderPanel.createOrShow(context, profileStore, savedQueriesStore, fmClient, logger, {
        profileId: contextArg.profileId,
        layout: contextArg.layout
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.refreshExplorer', () => {
      refreshExplorer();
    })
  ];
}
