import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryStore } from '../../../src/services/historyStore';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import { InMemoryMemento } from '../mocks';

/**
 * Which message of the Query Builder reaches which service, what the panel answers, and what it
 * refuses. The panel is not changed here: every expectation reads what the code does today.
 */

type Handler = (message: unknown) => void;

const profile = {
  id: 'p1',
  name: 'Production',
  authMode: 'direct' as const,
  serverUrl: 'https://fm.example.com',
  database: 'Sales'
};

const runPayload = { profileId: 'p1', layout: ' Contacts ', findJson: '[{" Name ":"Ada"}]' };

function open(overrides: { listProfiles?: () => Promise<unknown[]> } = {}) {
  let handler: Handler | undefined;
  let onDispose: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const reveal = vi.fn();

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message: Record<string, unknown>) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: (callback: Handler) => {
        handler = callback;
        return { dispose: vi.fn() };
      }
    },
    reveal,
    onDidDispose: (callback: () => void) => {
      onDispose = callback;
      return { dispose: vi.fn() };
    }
  } as never);

  const fmClient = {
    listLayouts: vi.fn(async () => ['Contacts']),
    getLayoutMetadata: vi.fn(async () => ({ fieldMetaData: [{ name: ' Name ', result: 'text' }] })),
    findRecords: vi.fn(async () => ({
      data: [{ recordId: '1', fieldData: { ' Name ': 'Ada' } }],
      dataInfo: { foundCount: 1 }
    })),
    listRecords: vi.fn(async () => ({ data: [], dataInfo: { foundCount: 0 } }))
  };
  const savedQueriesStore = {
    listSavedQueries: vi.fn(async () => []),
    getSavedQuery: vi.fn(async () => undefined),
    saveSavedQuery: vi.fn(async (query: Record<string, unknown>) => ({ ...query, id: 'q-new' }))
  };
  const profileStore = {
    listProfiles: vi.fn(overrides.listProfiles ?? (async () => [profile])),
    getProfile: vi.fn(async (id: string) => (id === profile.id ? profile : undefined)),
    getActiveProfileId: vi.fn(() => profile.id)
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  QueryBuilderPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
    profileStore as never,
    savedQueriesStore as never,
    fmClient as never,
    logger as never,
    undefined,
    new HistoryStore(new InMemoryMemento() as never)
  );

  const send = async (message: unknown): Promise<void> => {
    handler?.(message);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    send,
    posted,
    reveal,
    fmClient,
    savedQueriesStore,
    profileStore,
    logger,
    close: () => onDispose?.()
  };
}

describe('Query Builder: message routing', () => {
  let panel: ReturnType<typeof open>;

  beforeEach(() => {
    vi.clearAllMocks();
    panel = open();
  });

  afterEach(() => {
    panel.close();
    (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  describe('every message reaches its handler', () => {
    it('answers "ready" with the init state and the history', async () => {
      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual(
        expect.objectContaining({
          type: 'init',
          payload: expect.objectContaining({
            profiles: [expect.objectContaining({ id: 'p1', name: 'Production', database: 'Sales', authMode: 'direct' })],
            activeProfileId: 'p1',
            savedQueries: []
          })
        })
      );
      expect(panel.posted).toContainEqual({ type: 'history', payload: [] });
      expect(panel.fmClient.findRecords).not.toHaveBeenCalled();
    });

    it('answers "loadLayouts" with the layouts of that profile', async () => {
      await panel.send({ type: 'loadLayouts', profileId: 'p1' });

      expect(panel.fmClient.listLayouts).toHaveBeenCalledWith(profile);
      expect(panel.posted).toContainEqual({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    });

    it('answers "loadFieldNames" with the fields of that layout', async () => {
      await panel.send({ type: 'loadFieldNames', profileId: 'p1', layout: 'Contacts' });

      expect(panel.fmClient.getLayoutMetadata).toHaveBeenCalledWith(profile, 'Contacts');
      expect(panel.posted).toContainEqual(
        expect.objectContaining({ type: 'fieldNamesLoaded', payload: expect.objectContaining({ profileId: 'p1', layout: 'Contacts' }) })
      );
    });

    it('answers "uploadContainer" with the result of the upload command', async () => {
      vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce(true);

      await panel.send({ type: 'uploadContainer', payload: { profileId: 'p1', layout: 'Contacts' } });

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('filemakerDataApiTools.uploadContainer', {
        profileId: 'p1',
        layout: 'Contacts'
      });
      expect(panel.posted).toContainEqual({ type: 'containerUploadResult', payload: { completed: true } });
    });

    it('answers "refreshHistory" with the history again', async () => {
      await panel.send({ type: 'refreshHistory' });

      expect(panel.posted).toContainEqual({ type: 'history', payload: [] });
    });

    it('answers "exportResultsCsvFile" with the rows of the last run', async () => {
      await panel.send({ type: 'runQuery', payload: runPayload });
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce('Standard CSV' as never);

      await panel.send({ type: 'exportResultsCsvFile' });

      expect(vi.mocked(vscode.window.showQuickPick)).toHaveBeenCalledWith(
        ['Standard CSV', 'Excel-compatible CSV (UTF-8 BOM)'],
        { title: 'CSV format' }
      );
      // The save dialog is left unanswered, so no file is written by the test.
      expect(vi.mocked(vscode.window.showSaveDialog)).toHaveBeenCalled();
      expect(panel.posted.some((message) => message.type === 'error')).toBe(false);
    });
  });

  describe('a message the panel cannot use is ignored', () => {
    it('ignores a message of an unknown type: nothing is posted and no service is called', async () => {
      await panel.send({ type: 'somethingElse', payload: { profileId: 'p1' } });

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.listProfiles).not.toHaveBeenCalled();
      expect(panel.profileStore.getProfile).not.toHaveBeenCalled();
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
      expect(panel.logger.error).not.toHaveBeenCalled();
      expect(panel.logger.warn).not.toHaveBeenCalled();
    });

    it('ignores a message that is not an object', async () => {
      for (const message of [null, 'ready', 42]) {
        await panel.send(message);
      }

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.listProfiles).not.toHaveBeenCalled();
    });

    it('ignores "loadLayouts" without a profile id', async () => {
      await panel.send({ type: 'loadLayouts' });
      await panel.send({ type: 'loadLayouts', profileId: 42 });

      expect(panel.posted).toEqual([]);
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
    });
  });

  describe('a failure is posted to the webview as an error', () => {
    it('reports a profile that no longer exists', async () => {
      await panel.send({ type: 'loadLayouts', profileId: 'gone' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The selected connection profile could not be found.' });
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
    });

    it('reports layouts that cannot be listed, and logs it', async () => {
      panel.fmClient.listLayouts.mockRejectedValueOnce(new Error('Layouts are unavailable.'));

      await panel.send({ type: 'loadLayouts', profileId: 'p1' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Layouts are unavailable.' });
      expect(panel.logger.error).toHaveBeenCalledWith('Failed to load layouts for query builder.', { profileId: 'p1', error: expect.any(Error) });
    });

    it('reports field names that cannot be read, in the payload the page reads', async () => {
      panel.fmClient.getLayoutMetadata.mockRejectedValueOnce(new Error('Metadata is unavailable.'));

      await panel.send({ type: 'loadFieldNames', profileId: 'p1', layout: 'Contacts' });

      expect(panel.posted).toContainEqual({
        type: 'fieldNamesLoaded',
        payload: { profileId: 'p1', layout: 'Contacts', fieldNames: [], error: 'Metadata is unavailable.' }
      });
      expect(panel.logger.warn).toHaveBeenCalledWith('Failed to load field names for query builder.', { profileId: 'p1', layout: 'Contacts', error: expect.any(Error) });
    });

    it('reports a profile that is gone when the fields are asked for', async () => {
      await panel.send({ type: 'loadFieldNames', profileId: 'gone', layout: 'Contacts' });

      expect(panel.posted).toContainEqual({
        type: 'fieldNamesLoaded',
        payload: { profileId: 'gone', layout: 'Contacts', fieldNames: [], error: 'Profile not found.' }
      });
      expect(panel.fmClient.getLayoutMetadata).not.toHaveBeenCalled();
    });

    it('reports an upload that cannot start', async () => {
      vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('The container could not be uploaded.'));

      await panel.send({ type: 'uploadContainer', payload: { profileId: 'p1', layout: 'Contacts' } });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The container could not be uploaded.' });
      expect(panel.posted.some((message) => message.type === 'containerUploadResult')).toBe(false);
    });

    it('reports a record that cannot be opened', async () => {
      vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('The record could not be opened.'));

      await panel.send({ type: 'openRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '42', mode: 'view' } });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The record could not be opened.' });
    });

    it('reports a failure inside the request in the panel error shape', async () => {
      panel.close();
      panel = open({ listProfiles: async () => { throw new Error('Profiles are unavailable.'); } });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Profiles are unavailable.' });
      expect(panel.logger.error).toHaveBeenCalledWith('Query builder request failed.', { type: 'ready', error: expect.any(Error) });
    });

    it('reports a failure that is not an Error with a plain reason', async () => {
      panel.close();
      panel = open({ listProfiles: async () => { throw 'the socket closed'; } });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Unknown error while processing query builder request.' });
    });

    it('writes the failure to the log when the page cannot be told about it', async () => {
      const postMessage = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value.webview.postMessage as
        ReturnType<typeof vi.fn>;
      postMessage.mockRejectedValue(new Error('The webview is gone.'));

      await panel.send({ type: 'ready' });

      expect(panel.logger.error).toHaveBeenCalledWith('Query builder request failed.', expect.anything());
      expect(panel.logger.error).toHaveBeenCalledWith('Could not post the Query builder request failure to the page.', expect.anything());
    });
  });

  describe('the panel is opened once and reused', () => {
    it('reveals the open panel and sends the new state instead of opening a second one', async () => {
      await panel.send({ type: 'ready' });
      const before = panel.posted.length;

      QueryBuilderPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
        panel.profileStore as never,
        panel.savedQueriesStore as never,
        panel.fmClient as never,
        panel.logger as never,
        { profileId: 'p2' },
        new HistoryStore(new InMemoryMemento() as never)
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(1);
      expect(panel.reveal).toHaveBeenCalledTimes(1);
      expect(panel.posted.length).toBeGreaterThan(before);
      expect(panel.posted.slice(before)).toContainEqual(
        expect.objectContaining({ type: 'init', payload: expect.objectContaining({ defaults: { profileId: 'p2' } }) })
      );
    });

    it('asks the open panel to save the current query, and says so when there is none', async () => {
      expect(QueryBuilderPanel.requestSaveCurrentQuery()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(panel.posted).toContainEqual({ type: 'saveCurrentQuery' });

      panel.close();
      (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      expect(QueryBuilderPanel.requestSaveCurrentQuery()).toBe(false);
    });
  });
});
