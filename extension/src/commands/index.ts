import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SavedQueriesStore } from '../services/savedQueriesStore';
import type { SecretStore } from '../services/secretStore';
import type { FindRecordsRequest } from '../types/fm';
import { localize } from '../i18n';
import {
  parseFindJson,
  parseOptionalNonNegativeInteger,
  parseSortJson,
  validateRecordId
} from '../utils/jsonValidate';
import {
  openJsonDocument,
  parseLayoutArg,
  promptForLayout,
  resolveProfileFromArg,
  showCommandError
} from './common';
import { ConnectionWizardPanel } from '../webviews/connectionWizard';
import { QueryBuilderPanel } from '../webviews/queryBuilder';
import { RecordViewerPanel } from '../webviews/recordViewer';
import { retryWithBackoff, type BackoffPolicy } from '../utils/backoff';
import { showConnectionQuickPick } from '../views/connectionStatusBar';

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
      if (
        !(await roleGuard.assertFeature(
          'writeOperations',
          localize('commands.core.addProfile.featureName', 'Add Connection Profile')
        ))
      ) {
        return;
      }

      ConnectionWizardPanel.createOrShow(
        context,
        profileStore,
        secretStore,
        fmClient,
        logger,
        undefined,
        {
          getTestPolicy: deps.getConnectionWizardTestPolicy
        }
      );
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.editConnectionProfile',
      async (arg: unknown) => {
        const profile = await resolveProfileFromArg(arg, profileStore);
        if (!profile) {
          return;
        }
        if (roleGuard.isProfileLocked(profile.id)) {
          vscode.window.showWarningMessage(
            localize(
              'commands.core.profileLocked',
              'This profile is locked by enterprise configuration.'
            )
          );
          return;
        }
        if (
          !(await roleGuard.assertFeature(
            'writeOperations',
            localize('commands.core.editProfile.featureName', 'Edit Connection Profile')
          ))
        ) {
          return;
        }

        ConnectionWizardPanel.createOrShow(
          context,
          profileStore,
          secretStore,
          fmClient,
          logger,
          profile,
          {
            getTestPolicy: deps.getConnectionWizardTestPolicy
          }
        );
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.removeConnectionProfile',
      async (arg: unknown) => {
        const profile = await resolveProfileFromArg(arg, profileStore);
        if (!profile) {
          return;
        }
        if (roleGuard.isProfileLocked(profile.id)) {
          vscode.window.showWarningMessage(
            localize(
              'commands.core.profileLocked',
              'This profile is locked by enterprise configuration.'
            )
          );
          return;
        }
        if (
          !(await roleGuard.assertFeature(
            'writeOperations',
            localize('commands.core.removeProfile.featureName', 'Remove Connection Profile')
          ))
        ) {
          return;
        }

        const removeLabel = localize('commands.core.removeProfile.action', 'Remove');
        const confirmation = await vscode.window.showWarningMessage(
          localize(
            'commands.core.removeProfile.confirm',
            'Remove profile "{0}" and all associated secrets?',
            profile.name
          ),
          { modal: true },
          removeLabel
        );

        if (confirmation !== removeLabel) {
          return;
        }

        await profileStore.removeProfile(profile.id);
        await savedQueriesStore.removeQueriesForProfile(profile.id);
        await secretStore.clearProfileSecrets(profile.id);

        fmClient.invalidateProfileCache(profile.id);
        onProfileDisconnected?.(profile.id);

        refreshExplorer();
        refreshConnectionStatus?.();
        vscode.window.showInformationMessage(
          localize('commands.core.removeProfile.success', 'Removed profile "{0}".', profile.name)
        );
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
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 110);
        try {
          statusBar.text = localize(
            'commands.core.connect.status.connecting',
            '$(sync~spin) FileMaker: Connecting to {0}...',
            profile.name
          );
          statusBar.show();

          await retryWithBackoff(() => fmClient.createSession(profile), policy, {
            shouldRetry: (err) => isRetryableConnectError(err),
            onRetry: ({ attempt, delayMs, error }) => {
              const seconds = Math.max(1, Math.round(delayMs / 1000));
              statusBar.text = localize(
                'commands.core.connect.status.retrying',
                '$(sync~spin) FileMaker: Connecting to {0} - retry {1}/{2} in {3}s',
                profile.name,
                attempt + 1,
                policy.maxRetries,
                seconds
              );
              logger.warn('Connect attempt failed; retrying with backoff.', {
                profileId: profile.id,
                attempt,
                delayMs,
                error
              });
            }
          });

          await profileStore.setActiveProfileId(profile.id);
          refreshExplorer();
          refreshConnectionStatus?.();
          vscode.window.showInformationMessage(
            localize('commands.core.connect.success', 'Connected to "{0}".', profile.name)
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.core.connect.failed',
              'Failed to connect to FileMaker profile.'
            ),
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
        vscode.window.showInformationMessage(
          localize('commands.core.disconnect.success', 'Disconnected from "{0}".', profile.name)
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: localize(
            'commands.core.disconnect.failed',
            'Failed to disconnect from FileMaker profile.'
          ),
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
          fallbackMessage: localize('commands.core.listLayouts.failed', 'Failed to list layouts.'),
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
        title: localize('commands.core.runFind.title', 'Run Find'),
        prompt: localize('commands.core.runFind.findPrompt', 'Enter find query JSON array'),
        value: '[{}]',
        ignoreFocusOut: true
      });
      if (!findJsonInput) {
        return;
      }

      const sortJsonInput = await vscode.window.showInputBox({
        title: localize('commands.core.runFind.title', 'Run Find'),
        prompt: localize('commands.core.runFind.sortPrompt', 'Enter sort JSON array (optional)'),
        ignoreFocusOut: true
      });

      const limitInput = await vscode.window.showInputBox({
        title: localize('commands.core.runFind.title', 'Run Find'),
        prompt: localize('commands.core.runFind.limitPrompt', 'Enter limit (optional)'),
        ignoreFocusOut: true
      });

      const offsetInput = await vscode.window.showInputBox({
        title: localize('commands.core.runFind.title', 'Run Find'),
        prompt: localize('commands.core.runFind.offsetPrompt', 'Enter offset (optional)'),
        ignoreFocusOut: true
      });

      try {
        const findValidation = parseFindJson(findJsonInput);
        if (!findValidation.ok || !findValidation.value) {
          throw new Error(
            findValidation.error ??
              localize('commands.core.runFind.findInvalid', 'Find JSON is invalid.')
          );
        }

        let sortValidationValue: Array<Record<string, unknown>> | undefined;

        if (sortJsonInput && sortJsonInput.trim().length > 0) {
          const sortValidation = parseSortJson(sortJsonInput);
          if (!sortValidation.ok || !sortValidation.value) {
            throw new Error(
              sortValidation.error ??
                localize('commands.core.runFind.sortInvalid', 'Sort JSON is invalid.')
            );
          }

          sortValidationValue = sortValidation.value;
        }

        const request: FindRecordsRequest = {
          query: findValidation.value,
          sort: sortValidationValue,
          limit: parseOptionalNonNegativeInteger(
            limitInput,
            localize('commands.core.runFind.limitLabel', 'Limit')
          ),
          offset: parseOptionalNonNegativeInteger(
            offsetInput,
            localize('commands.core.runFind.offsetLabel', 'Offset')
          )
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
          fallbackMessage: localize('commands.core.runFind.failed', 'Failed to run find query.'),
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
        title: localize('commands.core.getRecord.title', 'Get Record by ID'),
        prompt: localize('commands.core.getRecord.prompt', 'Enter FileMaker record ID'),
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
          fallbackMessage: localize(
            'commands.core.getRecord.failed',
            'Failed to get record by ID.'
          ),
          logger,
          logMessage: 'Get record command failed.'
        });
      }
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.openRecordViewer',
      async (arg: unknown) => {
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
            vscode.window.showErrorMessage(
              localize('commands.core.selectedProfileNotFound', 'Selected profile not found.')
            );
            return;
          }

          layout = await promptForLayout(profile, fmClient);
        }

        if (layout) {
          recordId = await vscode.window.showInputBox({
            title: localize('commands.core.openRecordViewer.title', 'Open Record Viewer'),
            prompt: localize(
              'commands.core.openRecordViewer.recordIdPrompt',
              'Record ID (optional)'
            ),
            ignoreFocusOut: true
          });
        }

        RecordViewerPanel.createOrShow(context, profileStore, fmClient, logger, {
          profileId,
          layout,
          recordId
        });
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.openQueryBuilder',
      async (arg: unknown) => {
        const contextArg = parseLayoutArg(arg);
        QueryBuilderPanel.createOrShow(context, profileStore, savedQueriesStore, fmClient, logger, {
          profileId: contextArg.profileId,
          layout: contextArg.layout
        });
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.refreshExplorer', () => {
      refreshExplorer();
    })
  ];
}
