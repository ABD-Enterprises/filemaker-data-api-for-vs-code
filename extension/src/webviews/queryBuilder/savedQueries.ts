import * as vscode from 'vscode';
import type { SaveQueryPayload } from './types';
import type { QueryBuilderContext } from './context';
import { toFindRequest } from './find';

export async function handleSaveQuery(context: QueryBuilderContext, payload: SaveQueryPayload): Promise<void> {
  const profile = await context.profileStore.getProfile(payload.profileId);
  if (!profile) {
    await context.postError('The selected profile no longer exists.');
    return;
  }

  try {
    const request = toFindRequest(payload);
    const existing = payload.queryId
      ? await context.savedQueriesStore.getSavedQuery(payload.queryId)
      : undefined;

    const name = await vscode.window.showInputBox({
      title: existing ? 'Save Query' : 'Save Query As',
      prompt: existing
        ? 'Query name. Keep it to update the saved query, or change it to rename.'
        : 'Name for the new saved query',
      value: payload.name.trim() || existing?.name || payload.layout,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a name.')
    });
    if (!name) {
      return;
    }

    const query = await context.savedQueriesStore.saveSavedQuery({
      id: existing?.id ?? payload.queryId,
      name: name.trim(),
      profileId: payload.profileId,
      database: profile.database,
      layout: payload.layout,
      findJson: request.query,
      sortJson: request.sort,
      limit: request.limit,
      offset: request.offset,
      createdAt: existing?.createdAt
    });

    await context.panel.webview.postMessage({
      type: 'savedQueries',
      payload: await context.savedQueriesStore.listSavedQueries()
    });

    await context.panel.webview.postMessage({
      type: 'querySaved',
      payload: { id: query.id, name: query.name }
    });

    await vscode.commands.executeCommand('filemakerDataApiTools.refreshExplorer');
    vscode.window.showInformationMessage(`Saved query "${query.name}".`);
  } catch (error) {
    await context.postError(context.formatError(error));
  }
}
