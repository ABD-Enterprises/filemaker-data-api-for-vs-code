import { readFileSync } from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { RecordViewerPanel } from '../../../src/webviews/recordViewer';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { InMemoryMemento } from '../mocks';

const uiSource = readFileSync(path.resolve(__dirname, '../../../src/webviews/recordViewer/ui/index.js'), 'utf8');
const profiles = [{ id: 'p1', name: 'Mock', database: 'Quality' }];

function pageHtml(): string {
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async () => true), onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })) },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never);
  (RecordViewerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  RecordViewerPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
    { listProfiles: vi.fn(async () => profiles), getProfile: vi.fn(), getActiveProfileId: () => 'p1' } as never,
    {} as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  );
  return (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
}

describe.skipIf(!JSDOM)('Record Viewer opened for a record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
  });

  const isSkeletonShown = (document: { querySelectorAll(s: string): ArrayLike<{ classList: { contains(t: string): boolean } }> }) =>
    Array.from(document.querySelectorAll('.loading-skeleton')).some((el) => !el.classList.contains('hidden'));

  it('loads the record by itself when opened with a record id and layout (no Load Record click needed)', () => {
    const { document, send, posted } = loadPage(pageHtml(), uiSource);
    send({ type: 'init', payload: { profiles, activeProfileId: 'p1', defaults: { profileId: 'p1', layout: 'Contacts', recordId: '42' } } });
    expect(document.getElementById('status')?.textContent).toBe('Loading record...');
    send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Orders', 'Contacts'] } });

    const load = posted.filter((message) => message.type === 'loadRecord');
    expect(load).toHaveLength(1);
    expect(load[0]?.payload).toEqual({ profileId: 'p1', layout: 'Contacts', recordId: '42' });
    // A second layouts message (a profile switch, a refresh) does not load again.
    send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Orders', 'Contacts'] } });
    expect(posted.filter((message) => message.type === 'loadRecord')).toHaveLength(1);
  });

  it('does not auto-load when the requested layout is not on the list', () => {
    const { document, send, posted } = loadPage(pageHtml(), uiSource);
    send({ type: 'init', payload: { profiles, activeProfileId: 'p1', defaults: { profileId: 'p1', layout: 'Gone', recordId: '42' } } });
    send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Orders'] } });
    expect(posted.some((message) => message.type === 'loadRecord')).toBe(false);
    expect(document.getElementById('recordIdInput')).toBeTruthy();
  });

  it('opened without a record: the form is shown with an explicit hint, not a loading skeleton', () => {
    const { document, send } = loadPage(pageHtml(), uiSource);
    send({ type: 'init', payload: { profiles, activeProfileId: 'p1', defaults: undefined } });
    expect(document.getElementById('status')?.textContent).toBe('Enter a record ID and select Load Record.');
    expect(isSkeletonShown(document as never)).toBe(false);
  });

  it('a failed automatic load shows the error and drops the skeleton', () => {
    const { document, send } = loadPage(pageHtml(), uiSource);
    send({ type: 'init', payload: { profiles, activeProfileId: 'p1', defaults: { profileId: 'p1', layout: 'Contacts', recordId: '42' } } });
    expect(isSkeletonShown(document as never)).toBe(true);
    send({ type: 'error', message: 'Record is missing.' });
    expect(isSkeletonShown(document as never)).toBe(false);
    expect(document.getElementById('status')?.textContent).toBe('Record is missing.');
  });
});
