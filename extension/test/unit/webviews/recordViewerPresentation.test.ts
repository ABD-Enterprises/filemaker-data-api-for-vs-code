import { expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';

it('pairs viewer type metadata with its own record when layout loads complete out of order', async () => {
  let receive: ((message: unknown) => void) | undefined;
  let releaseFirst: ((metadata: Record<string, unknown>) => void) | undefined;
  const posted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: { html: '', cspSource: 'x', asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message) => { posted.push(message); return true; }),
      onDidReceiveMessage: (callback: (message: unknown) => void) => { receive = callback; }
    }, onDidDispose: vi.fn(), reveal: vi.fn()
  } as never);
  (RecordViewerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  const client = {
    getRecord: vi.fn(async (_profile, layout: string) => ({ recordId: layout, fieldData: { Value: layout } })),
    getLayoutMetadata: vi.fn(async (_profile, layout: string) => layout === ' First '
      ? new Promise<Record<string, unknown>>((resolve) => { releaseFirst = resolve; })
      : { fieldMetaData: [{ name: 'Value', result: 'number' }] })
  };
  RecordViewerPanel.createOrShow({ extensionUri: vscode.Uri.file('/extension') } as never,
    { getProfile: async () => ({ id: 'p' }) } as never, client as never,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
  receive?.({ type: 'loadRecord', payload: { profileId: 'p', layout: ' First ', recordId: '1' } });
  await vi.waitFor(() => expect(releaseFirst).toBeDefined());
  receive?.({ type: 'loadRecord', payload: { profileId: 'p', layout: 'Second', recordId: '2' } });
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]?.payload).toMatchObject({ layout: 'Second', record: { recordId: 'Second' }, presentationFields: [{ name: 'Value', type: 'number' }] });
  releaseFirst?.({ fieldMetaData: [{ name: 'Value', result: 'text' }] });
  await vi.waitFor(() => expect(posted).toHaveLength(2));
  expect(posted[1]?.payload).toMatchObject({ layout: ' First ', record: { recordId: ' First ' }, presentationFields: [{ name: 'Value', type: 'text' }] });
});
