import { beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';

const profile = { id: 'p' };
const payload = (layout = ' Layout ') => ({ profileId: 'p', layout, recordId: '1' });
const record = (layout = ' Layout ') => ({ recordId: layout, fieldData: { Value: layout } });
const metadata = { fieldMetaData: [{ name: 'Value', result: 'number' }] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function viewer(client: object, getProfile = async () => profile) {
  const postMessage = vi.fn(async () => true);
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: { html: '', cspSource: 'x', asWebviewUri: (uri: unknown) => uri,
      postMessage, onDidReceiveMessage: vi.fn() },
    onDidDispose: vi.fn(), reveal: vi.fn()
  } as never);
  const panels = RecordViewerPanel as unknown as { currentPanel: {
    handleLoadRecord: (input: ReturnType<typeof payload>) => Promise<void>;
    exportRecord: () => Promise<void>;
  } | undefined };
  panels.currentPanel = undefined;
  RecordViewerPanel.createOrShow({ extensionUri: vscode.Uri.file('/extension') } as never,
    { getProfile } as never, client as never,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
  return { panel: panels.currentPanel!, postMessage };
}
beforeEach(() => vi.clearAllMocks());

it('does not request presentation metadata when schema metadata is disabled', async () => {
  const get = vi.fn((_key: string, fallback: unknown) => fallback);
  get.mockImplementation((key, fallback) => key === 'schema.metadataEnabled' ? false : fallback);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get } as never);
  try {
    const client = { getRecord: vi.fn(async () => record()), getLayoutMetadata: vi.fn(async () => metadata) };
    const { panel, postMessage } = viewer(client);
    await panel.handleLoadRecord(payload());
    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('filemaker');
    expect(client.getLayoutMetadata).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'recordLoaded', payload: { profileId: 'p', layout: ' Layout ', record: record(), presentationFields: [] } });
  } finally {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback } as never);
  }
});

it('starts metadata concurrently with the record, opts out of its history entry, and tolerates its failure', async () => {
  const pending = deferred<ReturnType<typeof record>>();
  const client = { getRecord: vi.fn(() => pending.promise), getLayoutMetadata: vi.fn(async () => { throw new Error('metadata unavailable'); }) };
  const { panel, postMessage } = viewer(client);
  const load = panel.handleLoadRecord(payload());
  await vi.waitFor(() => expect(client.getLayoutMetadata).toHaveBeenCalledWith(profile, ' Layout ', { recordHistory: false }));
  expect(postMessage).not.toHaveBeenCalled();
  pending.resolve(record());
  await load;
  expect(postMessage).toHaveBeenCalledWith({ type: 'recordLoaded', payload: { profileId: 'p', layout: ' Layout ', record: record(), presentationFields: [] } });
});

it('ignores old metadata after a newer load and exports only the newer record', async () => {
  const first = deferred<Record<string, unknown>>();
  const client = {
    getRecord: vi.fn(async (_profile, layout: string) => record(layout)),
    getLayoutMetadata: vi.fn(async (_profile, layout: string) => layout === ' First ' ? first.promise : metadata)
  };
  const { panel, postMessage } = viewer(client);
  const oldLoad = panel.handleLoadRecord(payload(' First '));
  await vi.waitFor(() => expect(client.getLayoutMetadata).toHaveBeenCalledTimes(1));
  await panel.handleLoadRecord(payload('Second'));
  first.resolve({ fieldMetaData: [{ name: 'Value', result: 'text' }] });
  await oldLoad;
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith({ type: 'recordLoaded', payload: { profileId: 'p', layout: 'Second', record: record('Second'), presentationFields: [expect.objectContaining({ name: 'Value', type: 'number' })] } });
  await panel.exportRecord();
  expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'json', content: JSON.stringify({ profileId: 'p', layout: 'Second', record: record('Second') }, null, 2) });
});

it('ignores a stale record error and a profile lookup that completes after a newer load', async () => {
  const first = deferred<ReturnType<typeof record>>();
  const client = { getRecord: vi.fn((_profile, layout: string) => layout === 'First' ? first.promise : Promise.resolve(record(layout))), getLayoutMetadata: vi.fn(async () => metadata) };
  const { panel, postMessage } = viewer(client);
  const oldLoad = panel.handleLoadRecord(payload('First'));
  await vi.waitFor(() => expect(client.getRecord).toHaveBeenCalledTimes(1));
  await panel.handleLoadRecord(payload('Second'));
  first.reject(new Error('stale error'));
  await oldLoad;
  expect(postMessage).toHaveBeenCalledTimes(1);

  const slowProfile = deferred<typeof profile>();
  const second = viewer(client, vi.fn().mockReturnValueOnce(slowProfile.promise).mockResolvedValue(profile));
  const slowLoad = second.panel.handleLoadRecord(payload('Slow'));
  await second.panel.handleLoadRecord(payload('Newest'));
  slowProfile.resolve(profile);
  await slowLoad;
  expect(second.postMessage).toHaveBeenCalledTimes(1);
  expect(client.getRecord).not.toHaveBeenCalledWith(profile, 'Slow', '1');
});
