import { recordsToCsv } from '../../src/utils/exportCsv';
import { parseBatchUpdateInput } from '../../src/services/batchService';
import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { duplicatePhotoMetadata } from '../fixtures/duplicatePhoto';
import { HistoryStore } from '../../src/services/historyStore';
import { QueryBuilderPanel } from '../../src/webviews/queryBuilder';
import { InMemoryMemento } from './mocks';

type Handler = (message: unknown) => void;

const profile = {
  id: 'p1',
  name: 'Production',
  authMode: 'direct',
  serverUrl: 'https://fm.example.com',
  database: 'Sales'
};

function openPanel(overrides?: { findRecords?: ReturnType<typeof vi.fn> }) {
  let handler: Handler | undefined;
  let disposeHandler: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];

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
    reveal: vi.fn(),
    onDidDispose: (callback: () => void) => {
      disposeHandler = callback;
      return { dispose: vi.fn() };
    }
  } as never);

  const fmClient = {
    listLayouts: vi.fn(async () => ['Contacts']),
    getLayoutMetadata: vi.fn(async () => ({})),
    findRecords: overrides?.findRecords ?? vi.fn(async () => ({ data: [], dataInfo: { foundCount: 0 } }))
  };
  const savedQueriesStore = {
    listSavedQueries: vi.fn(async () => []),
    getSavedQuery: vi.fn(async () => undefined),
    saveSavedQuery: vi.fn(async (query: Record<string, unknown>) => ({ ...query, id: 'q-new' }))
  };
  const profileStore = {
    listProfiles: vi.fn(async () => [profile]),
    getProfile: vi.fn(async (id: string) => (id === profile.id ? profile : undefined)),
    getActiveProfileId: vi.fn(() => profile.id)
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

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

  return { send, posted, fmClient, savedQueriesStore, close: () => disposeHandler?.() };
}

describe('QueryBuilderPanel messages', () => {
  let panel: ReturnType<typeof openPanel>;

  beforeEach(() => {
    vi.clearAllMocks();
    panel?.close();
    panel = openPanel();
  });

  it('exports colliding and digit-only fields with unambiguous ordered metadata', () => {
    const panelType = QueryBuilderPanel as unknown as { prototype: { toCsvRows(input: unknown): Map<string, unknown>[] } };
    const rows = panelType.prototype.toCsvRows({ result: { data: [{ recordId: '42', modId: '7', fieldData: { recordId: 'field', modId: 'fieldmod', '123': 'digit' } }] } });
    const csv = recordsToCsv(rows);
    expect(csv.split('\n')[0]).toBe('__recordId,__modId,123,recordId,modId,__portalNote (export information)');
    expect(parseBatchUpdateInput(csv, 'csv')).toEqual([{ recordId: '42', fieldData: { recordId: 'field', modId: 'fieldmod', '123': 'digit' } }]);
  });

  it('loads duplicate Photo metadata without duplicate query choices', async () => {
    panel.fmClient.getLayoutMetadata.mockResolvedValueOnce(duplicatePhotoMetadata);
    await panel.send({ type: 'loadFieldNames', profileId: 'p1', layout: 'Contact Details' });
    expect(panel.posted.find((message) => message.type === 'fieldNamesLoaded')).toMatchObject({ payload: { fieldNames: ['Photo'], fieldMetadata: [expect.objectContaining({ name: 'Photo', type: 'container' }), expect.objectContaining({ name: 'Photo', type: 'container' })] } });
  });

  it('loads every webview script under the nonce', () => {
    const html = vi.mocked(vscode.window.createWebviewPanel).mock.results[0]?.value.webview.html as string;
    const nonces = [...html.matchAll(/<script nonce="([^"]+)" src="[^"]*(findForm|cellText|index)\.js"/g)];
    expect(nonces).toHaveLength(3);
    expect(html).toContain(`'nonce-${nonces[0]?.[1]}'`);
  });

  it('answers a run request that fails validation instead of leaving the webview waiting', async () => {
    await panel.send({ type: 'runQuery', payload: { profileId: 'p1', layout: 'Contacts', findJson: '', runId: 3 } });
    expect(panel.posted).toContainEqual(expect.objectContaining({ type: 'error', runId: 3 }));
    expect(panel.fmClient.findRecords).not.toHaveBeenCalled();
  });

  it.each(['limit', 'offset'])('refuses zero %s with a next step', async (field) => {
    await panel.send({ type: 'runQuery', payload: { profileId: 'p1', layout: 'Contacts', findJson: '[{"Name":"Ada"}]', [field]: 0, runId: 4 } });
    expect(panel.posted).toContainEqual(expect.objectContaining({ type: 'error', runId: 4, message: expect.stringContaining('must be at least 1') }));
    expect(panel.fmClient.findRecords).not.toHaveBeenCalled();
  });

  it('tags a failed run with its run id', async () => {
    panel.close();
    panel = openPanel({ findRecords: vi.fn(async () => Promise.reject(new Error('Field is missing'))) });
    await panel.send({
      type: 'runQuery',
      payload: { profileId: 'p1', layout: 'Contacts', findJson: '[{"Status":"Open"}]', runId: 9 }
    });
    expect(panel.posted).toContainEqual({ type: 'error', message: 'Field is missing', runId: 9 });
  });

  it('echoes the run id with query results', async () => {
    await panel.send({
      type: 'runQuery',
      payload: { profileId: 'p1', layout: 'Contacts', findJson: '[{"Status":"Open"}]', offset: 21, runId: 7 }
    });
    const result = panel.posted.find((message) => message.type === 'queryResult') as {
      payload: { query: { runId: number; offset: number } };
    };
    expect(result.payload.query).toMatchObject({ runId: 7, offset: 21 });
    expect(panel.fmClient.findRecords).toHaveBeenCalledWith(profile, 'Contacts', expect.objectContaining({ offset: 21 }));
  });

  it('shows script errors reported next to a find that worked, and shows nothing when there are none', async () => {
    panel.close();
    panel = openPanel({
      findRecords: vi.fn(async () => ({ data: [], dataInfo: { foundCount: 0 }, scriptErrors: [{ phase: 'prerequest' as const, code: '105' }] }))
    });
    await panel.send({ type: 'runQuery', payload: { profileId: 'p1', layout: 'Contacts', findJson: '[{"Status":"Open"}]', runId: 1 } });
    const warning = vi.mocked(vscode.window.showWarningMessage).mock.calls.map((call) => String(call[0])).join('\n');
    expect(warning).toMatch(/The find worked, but the pre-request script reported error 105/);
    expect(panel.posted.some((message) => message.type === 'queryResult')).toBe(true);

    vi.mocked(vscode.window.showWarningMessage).mockClear();
    panel.close();
    panel = openPanel();
    await panel.send({ type: 'runQuery', payload: { profileId: 'p1', layout: 'Contacts', findJson: '[{"Status":"Open"}]', runId: 2 } });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('opens a result row in the viewer or editor with its record id', async () => {
    await panel.send({ type: 'openRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '42', mode: 'edit' } });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('filemakerDataApiTools.openRecordEditor', {
      profileId: 'p1',
      layout: 'Contacts',
      recordId: '42'
    });

    await panel.send({ type: 'openRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '42' } });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'filemakerDataApiTools.openRecordViewer',
      expect.objectContaining({ recordId: '42' })
    );
  });

  it('rejects a non-numeric record id', async () => {
    await panel.send({ type: 'openRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '1; drop' } });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'filemakerDataApiTools.openRecordViewer',
      expect.anything()
    );
    expect(panel.posted).toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  it('copies text and refuses text over the size cap with an error', async () => {
    await panel.send({ type: 'copyText', text: 'a\tb', label: 'results table' });
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('a\tb');

    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    await panel.send({ type: 'copyText', text: 'x'.repeat(5_000_001), label: 'results table' });
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(panel.posted).toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  it('asks for a name when saving and stops if the prompt is cancelled', async () => {
    const payload = { profileId: 'p1', layout: 'Contacts', findJson: '[{"Status":"Open"}]', name: '' };

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
    await panel.send({ type: 'saveQuery', payload });
    expect(panel.savedQueriesStore.saveSavedQuery).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('Open contacts');
    await panel.send({ type: 'saveQuery', payload });
    expect(vscode.window.showInputBox).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'Contacts' }));
    expect(panel.savedQueriesStore.saveSavedQuery).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Open contacts', findJson: [{ Status: 'Open' }] })
    );
    expect(panel.posted).toContainEqual({ type: 'querySaved', payload: { id: 'q-new', name: 'Open contacts' } });
  });
});
