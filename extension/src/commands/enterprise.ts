import * as vscode from 'vscode';

import type { EnvironmentCompareService } from '../enterprise/environmentCompareService';
import type { EnvironmentSetStore } from '../enterprise/environmentSetStore';
import type { RoleGuard } from '../enterprise/roleGuard';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SettingsService } from '../services/settingsService';
import type { ConnectionProfile, EnvironmentCompareResult, EnvironmentSet } from '../types/fm';
import { localize } from '../i18n';
import { openJsonDocument, showCommandError } from './common';
import { EnvironmentComparePanel } from '../webviews/environmentCompare';

interface RegisterEnterpriseCommandsDeps {
  profileStore: ProfileStore;
  environmentSetStore: EnvironmentSetStore;
  compareService: EnvironmentCompareService;
  roleGuard: RoleGuard;
  settingsService: SettingsService;
  logger: Logger;
  refreshExplorer: () => void;
}

let lastCompareResult: EnvironmentCompareResult | undefined;

export function registerEnterpriseCommands(
  deps: RegisterEnterpriseCommandsDeps
): vscode.Disposable[] {
  const {
    profileStore,
    environmentSetStore,
    compareService,
    roleGuard,
    settingsService,
    logger,
    refreshExplorer
  } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.createEnvironmentSet', async () => {
      if (
        !(await roleGuard.assertFeature(
          'writeOperations',
          localize('commands.enterprise.createSet.featureName', 'Create Environment Set')
        ))
      ) {
        return;
      }

      const profiles = await profileStore.listProfiles();
      if (profiles.length < 2) {
        vscode.window.showWarningMessage(
          localize(
            'commands.enterprise.createSet.needTwoProfiles',
            'At least two profiles are required to create an environment set.'
          )
        );
        return;
      }

      const name = await vscode.window.showInputBox({
        title: localize('commands.enterprise.createSet.title', 'Create Environment Set'),
        prompt: localize('commands.enterprise.createSet.namePrompt', 'Environment set name'),
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length === 0
            ? localize('commands.enterprise.createSet.nameRequired', 'Name is required.')
            : undefined
      });

      if (!name) {
        return;
      }

      const pickedProfiles = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
          label: profile.name,
          description: `${profile.database} • ${profile.authMode}`,
          profileId: profile.id
        })),
        {
          title: localize(
            'commands.enterprise.createSet.selectProfiles',
            'Select profiles for environment set'
          ),
          canPickMany: true,
          ignoreFocusOut: true
        }
      );

      if (!pickedProfiles || pickedProfiles.length < 2) {
        vscode.window.showWarningMessage(
          localize(
            'commands.enterprise.createSet.selectTwoProfiles',
            'Select at least two profiles.'
          )
        );
        return;
      }

      await environmentSetStore.upsertEnvironmentSet({
        name,
        profiles: pickedProfiles.map((item) => item.profileId)
      });

      refreshExplorer();
      vscode.window.showInformationMessage(
        localize('commands.enterprise.createSet.success', 'Created environment set "{0}".', name)
      );
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.compareEnvironments',
      async (arg: unknown) => {
        const environmentSet = await resolveEnvironmentSet(arg, environmentSetStore);
        if (!environmentSet) {
          return;
        }

        try {
          const profiles = await resolveProfilesForSet(environmentSet, profileStore);
          const result = await compareService.compareEnvironmentSet(environmentSet, profiles, {
            concurrency: settingsService.getBatchConcurrency(),
            hashAlgorithm: settingsService.getSchemaHashAlgorithm()
          });

          lastCompareResult = result;
          EnvironmentComparePanel.createOrShow(
            { compare: result },
            localize(
              'commands.enterprise.compare.panelTitle',
              'Env Compare: {0}',
              environmentSet.name
            )
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.enterprise.compare.failed',
              'Environment compare failed.'
            ),
            logger,
            logMessage: 'Environment compare failed.'
          });
        }
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.diffLayoutAcrossEnvironments',
      async (arg: unknown) => {
        const parsed = parseSetAndLayoutArg(arg);
        const environmentSet = await resolveEnvironmentSet(parsed, environmentSetStore);
        if (!environmentSet) {
          return;
        }

        const profiles = await resolveProfilesForSet(environmentSet, profileStore);
        if (profiles.length < 2) {
          vscode.window.showErrorMessage(
            localize(
              'commands.enterprise.diff.needTwoProfiles',
              'Environment set must reference at least two existing profiles.'
            )
          );
          return;
        }

        const layout =
          parsed.layout ??
          (await pickLayoutForEnvironment(environmentSet, profiles, compareService, vscode.window));
        if (!layout) {
          return;
        }

        try {
          const result = await compareService.diffLayoutAcrossEnvironments(
            environmentSet,
            layout,
            profiles,
            {
              concurrency: settingsService.getBatchConcurrency(),
              hashAlgorithm: settingsService.getSchemaHashAlgorithm()
            }
          );

          EnvironmentComparePanel.createOrShow(
            {
              layoutDiff: result
            },
            localize(
              'commands.enterprise.diff.panelTitle',
              'Layout Diff: {0} / {1}',
              environmentSet.name,
              layout
            )
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.enterprise.diff.failed',
              'Diff layout across environments failed.'
            ),
            logger,
            logMessage: 'Diff layout across environments failed.'
          });
        }
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.exportEnvironmentComparisonReport',
      async (arg: unknown) => {
        const allowed = await roleGuard.assertFeature(
          'environmentExport',
          localize('commands.enterprise.export.featureName', 'Export environment comparison report')
        );
        if (!allowed) {
          return;
        }

        const environmentSet = await resolveEnvironmentSet(arg, environmentSetStore);

        let result = lastCompareResult;

        if (environmentSet) {
          const profiles = await resolveProfilesForSet(environmentSet, profileStore);
          result = await compareService.compareEnvironmentSet(environmentSet, profiles, {
            concurrency: settingsService.getBatchConcurrency(),
            hashAlgorithm: settingsService.getSchemaHashAlgorithm()
          });
          lastCompareResult = result;
        }

        if (!result) {
          vscode.window.showInformationMessage(
            localize(
              'commands.enterprise.export.compareFirst',
              'Run FileMaker: Compare Environments first.'
            )
          );
          return;
        }

        const format = await vscode.window.showQuickPick(
          [
            {
              label: localize('commands.enterprise.export.formatJson', 'JSON'),
              value: 'json' as const
            },
            {
              label: localize('commands.enterprise.export.formatMarkdown', 'Markdown'),
              value: 'md' as const
            }
          ],
          {
            title: localize(
              'commands.enterprise.export.formatTitle',
              'Export environment comparison report as'
            )
          }
        );

        if (!format) {
          return;
        }

        const extension = format.value === 'json' ? 'json' : 'md';
        const uri = await vscode.window.showSaveDialog({
          title: localize(
            'commands.enterprise.export.saveDialogTitle',
            'Export Environment Comparison Report'
          ),
          defaultUri: vscode.Uri.file(`filemaker-environment-compare.${extension}`),
          filters: format.value === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] }
        });

        if (!uri) {
          return;
        }

        const content =
          format.value === 'json'
            ? JSON.stringify(result, null, 2)
            : compareService.toMarkdownReport(result);

        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(
          localize('commands.enterprise.export.success', 'Exported environment comparison report.')
        );
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.openEnvironmentSetJson',
      async (arg: unknown) => {
        const environmentSet = await resolveEnvironmentSet(arg, environmentSetStore);
        if (!environmentSet) {
          return;
        }

        await openJsonDocument(environmentSet);
      }
    )
  ];
}

async function resolveEnvironmentSet(
  arg: unknown,
  environmentSetStore: EnvironmentSetStore
): Promise<EnvironmentSet | undefined> {
  const parsed = parseSetAndLayoutArg(arg);

  if (parsed.environmentSetId) {
    const byId = await environmentSetStore.getEnvironmentSet(parsed.environmentSetId);
    if (!byId) {
      vscode.window.showErrorMessage(
        localize(
          'commands.enterprise.setNotFound',
          'Environment set {0} not found.',
          parsed.environmentSetId
        )
      );
      return undefined;
    }

    return byId;
  }

  const items = await environmentSetStore.listEnvironmentSets();
  if (items.length === 0) {
    vscode.window.showInformationMessage(
      localize('commands.enterprise.noSets', 'No environment sets found. Create one first.')
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({
      label: item.name,
      description: item.profiles.join(', '),
      item
    })),
    {
      title: localize('commands.enterprise.selectSet.title', 'Select environment set')
    }
  );

  return picked?.item;
}

async function resolveProfilesForSet(
  environmentSet: EnvironmentSet,
  profileStore: ProfileStore
): Promise<ConnectionProfile[]> {
  const profiles = await profileStore.listProfiles();
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

  return environmentSet.profiles
    .map((profileId) => profileMap.get(profileId))
    .filter((profile): profile is ConnectionProfile => Boolean(profile));
}

async function pickLayoutForEnvironment(
  environmentSet: EnvironmentSet,
  profiles: ConnectionProfile[],
  compareService: EnvironmentCompareService,
  windowApi: typeof vscode.window
): Promise<string | undefined> {
  const compare = await compareService.compareEnvironmentSet(environmentSet, profiles);

  const picked = await windowApi.showQuickPick(
    compare.rows.map((row) => ({
      label: row.layout,
      description: Object.entries(row.presence)
        .map(([profileId, present]) => `${profileId}:${present ? 'Y' : 'N'}`)
        .join(' | '),
      layout: row.layout
    })),
    {
      title: localize('commands.enterprise.pickLayout.title', 'Select layout for environment diff')
    }
  );

  return picked?.layout;
}

function parseSetAndLayoutArg(arg: unknown): {
  environmentSetId?: string;
  layout?: string;
} {
  if (!arg || typeof arg !== 'object') {
    return {};
  }

  const value = arg as Record<string, unknown>;

  const environmentSetId =
    typeof value.environmentSetId === 'string'
      ? value.environmentSetId
      : typeof value.setId === 'string'
        ? value.setId
        : undefined;

  const layout = typeof value.layout === 'string' ? value.layout : undefined;

  return {
    environmentSetId,
    layout
  };
}
