import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import { executeSavedQueryAgainstClient } from '../services/savedQueryRunner';
import type { SavedQueriesStore } from '../services/savedQueriesStore';
import type { SavedQuery } from '../types/fm';
import { localize } from '../i18n';
import { parseFindJson, parseSortJson } from '../utils/jsonValidate';
import { openJsonDocument, parseSavedQueryArg, showCommandError } from './common';
import { QueryBuilderPanel } from '../webviews/queryBuilder';

interface RegisterSavedQueriesCommandDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  savedQueriesStore: SavedQueriesStore;
  fmClient: FMClient;
  logger: Logger;
  refreshExplorer: () => void;
}

export function registerSavedQueriesCommands(
  deps: RegisterSavedQueriesCommandDeps
): vscode.Disposable[] {
  const { context, profileStore, savedQueriesStore, fmClient, logger, refreshExplorer } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.saveCurrentQuery', async () => {
      const posted = QueryBuilderPanel.requestSaveCurrentQuery();
      if (!posted) {
        vscode.window.showInformationMessage(
          localize(
            'commands.savedQueries.openQueryBuilderFirst',
            'Open Query Builder first to save the current query.'
          )
        );
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.runSavedQuery', async (arg: unknown) => {
      const selected = await resolveSavedQuery(arg, savedQueriesStore);
      if (!selected) {
        return;
      }

      await runSavedQuery(selected, profileStore, savedQueriesStore, fmClient);
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.openSavedQuery',
      async (arg: unknown) => {
        const selected = await resolveSavedQuery(arg, savedQueriesStore);
        if (!selected) {
          return;
        }

        QueryBuilderPanel.createOrShow(context, profileStore, savedQueriesStore, fmClient, logger, {
          profileId: selected.profileId,
          layout: selected.layout,
          savedQuery: selected
        });
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.deleteSavedQuery',
      async (arg: unknown) => {
        const selected = await resolveSavedQuery(arg, savedQueriesStore);
        if (!selected) {
          return;
        }

        const deleteLabel = localize('commands.savedQueries.delete.action', 'Delete');
        const confirmation = await vscode.window.showWarningMessage(
          localize(
            'commands.savedQueries.delete.confirm',
            'Delete saved query "{0}"?',
            selected.name
          ),
          { modal: true },
          deleteLabel
        );

        if (confirmation !== deleteLabel) {
          return;
        }

        await savedQueriesStore.removeSavedQuery(selected.id);
        refreshExplorer();
        vscode.window.showInformationMessage(
          localize('commands.savedQueries.deleted', 'Deleted saved query "{0}".', selected.name)
        );
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.manageSavedQueries', async () => {
      const selected = await resolveSavedQuery(undefined, savedQueriesStore);
      if (!selected) {
        return;
      }

      const action = await vscode.window.showQuickPick(
        [
          { label: localize('commands.savedQueries.manage.run', 'Run'), value: 'run' },
          {
            label: localize(
              'commands.savedQueries.manage.openInQueryBuilder',
              'Open in Query Builder'
            ),
            value: 'open'
          },
          { label: localize('commands.savedQueries.manage.edit', 'Edit'), value: 'edit' },
          { label: localize('commands.savedQueries.manage.delete', 'Delete'), value: 'delete' },
          {
            label: localize('commands.savedQueries.manage.exportThisQuery', 'Export This Query'),
            value: 'export'
          }
        ],
        {
          title: localize(
            'commands.savedQueries.manage.title',
            'Manage Saved Query: {0}',
            selected.name
          )
        }
      );

      if (!action) {
        return;
      }

      switch (action.value) {
        case 'run':
          await runSavedQuery(selected, profileStore, savedQueriesStore, fmClient);
          break;
        case 'open':
          QueryBuilderPanel.createOrShow(
            context,
            profileStore,
            savedQueriesStore,
            fmClient,
            logger,
            {
              profileId: selected.profileId,
              layout: selected.layout,
              savedQuery: selected
            }
          );
          break;
        case 'edit':
          await editSavedQuery(selected, savedQueriesStore);
          refreshExplorer();
          break;
        case 'delete':
          await savedQueriesStore.removeSavedQuery(selected.id);
          refreshExplorer();
          vscode.window.showInformationMessage(
            localize('commands.savedQueries.deleted', 'Deleted saved query "{0}".', selected.name)
          );
          break;
        case 'export':
          await exportSingleQuery(selected);
          break;
        default:
          break;
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.exportSavedQueries', async () => {
      const payload = await savedQueriesStore.exportSavedQueries();
      const uri = await vscode.window.showSaveDialog({
        title: localize('commands.savedQueries.exportAll.title', 'Export Saved Queries'),
        filters: {
          JSON: ['json']
        },
        saveLabel: localize('commands.savedQueries.exportAll.saveLabel', 'Export Saved Queries'),
        defaultUri: vscode.Uri.file('saved-queries.json')
      });

      if (!uri) {
        return;
      }

      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
      );
      vscode.window.showInformationMessage(
        localize(
          'commands.savedQueries.exportAll.success',
          'Exported {0} saved queries.',
          payload.queries.length
        )
      );
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.importSavedQueries', async () => {
      const picks = await vscode.window.showOpenDialog({
        title: localize('commands.savedQueries.import.title', 'Import Saved Queries'),
        canSelectFiles: true,
        canSelectMany: false,
        filters: {
          JSON: ['json']
        }
      });

      const file = picks?.[0];
      if (!file) {
        return;
      }

      const rawBuffer = await vscode.workspace.fs.readFile(file);
      const result = await savedQueriesStore.importSavedQueries(
        Buffer.from(rawBuffer).toString('utf8')
      );

      refreshExplorer();
      vscode.window.showInformationMessage(
        localize(
          'commands.savedQueries.import.success',
          'Imported saved queries: {0} added, {1} updated, {2} skipped.',
          result.imported,
          result.updated,
          result.skipped
        )
      );
    })
  ];
}

export async function runSavedQuery(
  query: SavedQuery,
  profileStore: ProfileStore,
  savedQueriesStore: SavedQueriesStore,
  fmClient: FMClient
): Promise<void> {
  const profile = await profileStore.getProfile(query.profileId);

  if (!profile) {
    vscode.window.showErrorMessage(
      localize('commands.savedQueries.profileMissing', 'The saved query profile no longer exists.')
    );
    return;
  }

  try {
    const { request, result } = await executeSavedQueryAgainstClient(query, profile, fmClient);
    await savedQueriesStore.touchLastRun(query.id);

    await openJsonDocument({
      savedQuery: {
        id: query.id,
        name: query.name
      },
      profile: profile.name,
      layout: query.layout,
      request,
      result
    });
  } catch (error) {
    await showCommandError(error, {
      fallbackMessage: localize('commands.savedQueries.runFailed', 'Failed to run saved query.')
    });
  }
}

async function resolveSavedQuery(
  arg: unknown,
  savedQueriesStore: SavedQueriesStore
): Promise<SavedQuery | undefined> {
  const parsedArg = parseSavedQueryArg(arg);

  if (parsedArg.queryId) {
    const match = await savedQueriesStore.getSavedQuery(parsedArg.queryId);
    if (!match) {
      vscode.window.showErrorMessage(
        localize('commands.savedQueries.notFound', 'Saved query {0} not found.', parsedArg.queryId)
      );
    }

    return match;
  }

  const all = await savedQueriesStore.listSavedQueries({
    profileId: parsedArg.profileId
  });

  if (all.length === 0) {
    vscode.window.showInformationMessage(
      localize('commands.savedQueries.noneFound', 'No saved queries found.')
    );
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    all.map((query) => ({
      label: query.name,
      detail: `${query.layout} • ${query.profileId}`,
      description: query.lastRunAt
        ? localize('commands.savedQueries.lastRun', 'Last run {0}', query.lastRunAt)
        : localize('commands.savedQueries.neverRun', 'Never run'),
      query
    })),
    {
      title: localize('commands.savedQueries.select.title', 'Select Saved Query')
    }
  );

  return selected?.query;
}

async function editSavedQuery(
  query: SavedQuery,
  savedQueriesStore: SavedQueriesStore
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: localize('commands.savedQueries.edit.title', 'Edit Saved Query'),
    prompt: localize('commands.savedQueries.edit.namePrompt', 'Query name'),
    value: query.name,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0
        ? localize('commands.savedQueries.edit.nameRequired', 'Query name is required.')
        : undefined
  });

  if (!name) {
    return;
  }

  const findJsonInput = await vscode.window.showInputBox({
    title: localize('commands.savedQueries.edit.title', 'Edit Saved Query'),
    prompt: localize('commands.savedQueries.edit.findPrompt', 'Find JSON array'),
    value: JSON.stringify(query.findJson, null, 2),
    ignoreFocusOut: true
  });

  if (!findJsonInput) {
    return;
  }

  const sortJsonInput = await vscode.window.showInputBox({
    title: localize('commands.savedQueries.edit.title', 'Edit Saved Query'),
    prompt: localize('commands.savedQueries.edit.sortPrompt', 'Sort JSON array (optional)'),
    value: query.sortJson ? JSON.stringify(query.sortJson, null, 2) : '',
    ignoreFocusOut: true
  });

  const findValidation = parseFindJson(findJsonInput);
  if (!findValidation.ok || !findValidation.value) {
    vscode.window.showErrorMessage(
      findValidation.error ??
        localize('commands.savedQueries.edit.findInvalid', 'Find JSON is invalid.')
    );
    return;
  }

  let sortJson: Array<Record<string, unknown>> | undefined;

  if (sortJsonInput && sortJsonInput.trim().length > 0) {
    const sortValidation = parseSortJson(sortJsonInput);
    if (!sortValidation.ok || !sortValidation.value) {
      vscode.window.showErrorMessage(
        sortValidation.error ??
          localize('commands.savedQueries.edit.sortInvalid', 'Sort JSON is invalid.')
      );
      return;
    }

    sortJson = sortValidation.value;
  }

  await savedQueriesStore.saveSavedQuery({
    ...query,
    name: name.trim(),
    findJson: findValidation.value,
    sortJson
  });

  vscode.window.showInformationMessage(
    localize('commands.savedQueries.updated', 'Updated saved query "{0}".', name.trim())
  );
}

async function exportSingleQuery(query: SavedQuery): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    title: localize('commands.savedQueries.exportSingle.title', 'Export Saved Query'),
    filters: {
      JSON: ['json']
    },
    defaultUri: vscode.Uri.file(`${safeFileName(query.name)}.json`)
  });

  if (!uri) {
    return;
  }

  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          queries: [query]
        },
        null,
        2
      ),
      'utf8'
    )
  );

  vscode.window.showInformationMessage(
    localize(
      'commands.savedQueries.exportSingle.success',
      'Exported saved query "{0}".',
      query.name
    )
  );
}

function safeFileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}
