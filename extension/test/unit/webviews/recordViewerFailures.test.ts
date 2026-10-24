import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';

const uiSource = readFileSync(path.resolve(__dirname, '../../../src/webviews/recordViewer/ui/index.js'), 'utf8');
const profile = { id: 'p', name: 'Mock', database: 'DB', serverUrl: 'https://fm.invalid', mode: 'direct' };
const payload = (layout = ' Layout ') => ({ profileId: 'p', layout, recordId: '1' });
const record = (value = 'exact value') => ({ recordId: '1', fieldData: { ' Field ': value } });
const metadata = { fieldMetaData: [{ name: ' Field ', result: 'number' }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function viewer(client: object) {
  let receive!: (message: unknown) => void;
  let page: ReturnType<typeof loadPage>;
  const webview = { html: '', cspSource: 'x', asWebviewUri: (uri: unknown) => uri,
    postMessage: vi.fn(async (message: unknown) => { page.send(message); return true; }),
    onDidReceiveMessage: vi.fn((listener: typeof receive) => { receive = listener; }) };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({ webview, onDidDispose: vi.fn(), reveal: vi.fn() } as never);
  (RecordViewerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  RecordViewerPanel.createOrShow({ extensionUri: vscode.Uri.file('/extension') } as never,
    { getProfile: async () => profile, listProfiles: async () => [profile], getActiveProfileId: () => 'p' } as never,
    client as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
  page = loadPage(webview.html, uiSource);
  return { ...page, receive, postMessage: webview.postMessage };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback } as never));

describe.skipIf(!JSDOM)('Record Viewer host failures reach the page', () => {
  it('still displays the exact record when presentation metadata is unavailable', async () => {
    const client = { getRecord: vi.fn(async () => record()), getLayoutMetadata: vi.fn().mockRejectedValue(new Error('metadata unavailable')) };
    const page = viewer(client);
    page.receive({ type: 'loadRecord', payload: payload() });
    await vi.waitFor(() => expect(page.document.getElementById('status')?.textContent).toBe('Loaded record 1.'));
    expect(client.getRecord).toHaveBeenCalledWith(profile, ' Layout ', '1');
    expect(client.getLayoutMetadata).toHaveBeenCalledWith(profile, ' Layout ', { recordHistory: false });
    expect(page.document.querySelectorAll('#fieldDataContainer input')[0]?.value).toBe('exact value');
    expect(page.document.querySelectorAll('#fieldDataContainer td')[0]?.textContent).toContain(' Field ');
    expect(page.postMessage).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ presentationFields: [] }) }));
  });

  it('shows a record load error and removes the loading skeleton', async () => {
    const page = viewer({ getRecord: vi.fn().mockRejectedValue(new Error('Record is missing.')), getLayoutMetadata: async () => metadata });
    page.send({ type: 'init', payload: { profiles: [profile], defaults: payload() } });
    page.receive({ type: 'loadRecord', payload: payload() });
    await vi.waitFor(() => expect(page.document.getElementById('status')?.textContent).toBe('Record is missing.'));
    expect(page.document.getElementById('status')?.classList.contains('error')).toBe(true);
    expect(page.document.querySelectorAll('.loading-skeleton:not(.hidden)')).toHaveLength(0);
    expect(page.document.querySelectorAll('#fieldDataContainer tbody tr')).toHaveLength(0);
  });

  it.each(['success', 'failure'] as const)('a stale record %s cannot replace the newer record or its status', async (outcome) => {
    const first = deferred<ReturnType<typeof record>>();
    const client = { getRecord: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(record('new value')), getLayoutMetadata: async () => metadata };
    const page = viewer(client);
    page.receive({ type: 'loadRecord', payload: payload(' Old ') });
    await vi.waitFor(() => expect(client.getRecord).toHaveBeenCalledTimes(1));
    page.receive({ type: 'loadRecord', payload: payload(' New ') });
    await vi.waitFor(() => expect(page.document.querySelectorAll('#fieldDataContainer input')[0]?.value).toBe('new value'));
    if (outcome === 'success') first.resolve(record('old value'));
    else first.reject(new Error('stale error'));
    // Drain both Promise.all and the message handler before asserting the absence of a stale post.
    await first.promise.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(page.postMessage).toHaveBeenCalledTimes(1);
    expect(page.document.querySelectorAll('#fieldDataContainer input')[0]?.value).toBe('new value');
    expect(page.document.getElementById('status')?.textContent).toBe('Loaded record 1.');
    page.receive({ type: 'exportRecord' });
    await vi.waitFor(() => expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'json', content: JSON.stringify({ profileId: 'p', layout: ' New ', record: record('new value') }, null, 2) }));
  });

  it('disabling schema metadata skips its request and still displays the record', async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => key === 'schema.metadataEnabled' ? false : fallback } as never);
    const client = { getRecord: vi.fn(async () => record()), getLayoutMetadata: vi.fn(async () => metadata) };
    const page = viewer(client);
    page.receive({ type: 'loadRecord', payload: payload() });
    await vi.waitFor(() => expect(page.document.querySelectorAll('#fieldDataContainer input')[0]?.value).toBe('exact value'));
    expect(client.getLayoutMetadata).not.toHaveBeenCalled();
    expect(page.postMessage).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ presentationFields: [] }) }));
  });

  it('allows retrying Load more after an error and keeps the loaded portal rows', async () => {
    const page = viewer({});
    page.send({ type: 'recordLoaded', payload: { ...payload(), record: { ...record(), portalData: { ' Lines ': [{ A: 'keep' }] },
      portalDataInfo: [{ portalObjectName: ' Lines ', foundCount: 60, returnedCount: 1 }] } } });
    const more = page.document.querySelectorAll('#relatedDataContainer button')[0];
    expect(more).toBeDefined();
    more!.click();
    expect(more!.getAttribute('disabled')).not.toBeNull();
    page.send({ type: 'error', message: 'Portal request failed.' });
    expect(page.document.getElementById('status')?.textContent).toBe('Portal request failed.');
    expect(more!.getAttribute('disabled')).toBeNull();
    more!.click();
    expect(page.posted.filter((message) => message.type === 'loadRecord')).toHaveLength(2);
    expect(page.document.getElementById('relatedDataContainer')?.textContent).toContain('keep');
  });

  it('shows layout-list failures', async () => {
    const page = viewer({ listLayouts: vi.fn().mockRejectedValue(new Error('Layouts unavailable.')) });
    page.receive({ type: 'loadLayouts', profileId: 'p' });
    await vi.waitFor(() => expect(page.document.getElementById('status')?.textContent).toBe('Layouts unavailable.'));
  });

  it('shows copy-request delivery failures', async () => {
    vi.mocked(vscode.env.clipboard.writeText).mockRejectedValueOnce(new Error('Clipboard unavailable.'));
    const page = viewer({});
    page.receive({ type: 'copyRecordRequest', payload: { ...payload(), operation: 'get', format: 'curl' } });
    await vi.waitFor(() => expect(page.document.getElementById('status')?.textContent).toBe('Clipboard unavailable.'));
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1);
  });
});
