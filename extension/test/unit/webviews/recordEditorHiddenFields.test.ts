import { readFileSync } from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { InMemoryMemento } from '../mocks';

const uiSource = readFileSync(path.resolve(__dirname, '../../../src/webviews/recordEditor/ui/index.js'), 'utf8');

function pageHtml(): string {
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async () => true), onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })) },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never);
  (RecordEditorPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  RecordEditorPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
    { listProfiles: vi.fn(async () => []), getProfile: vi.fn(), getActiveProfileId: () => undefined } as never,
    {} as never,
    {} as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  );
  return (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
}

describe.skipIf(!JSDOM)('Record Editor: fields the account cannot see', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
  });

  const load = (fieldData: Record<string, unknown>, fields: Array<{ name: string }>) => {
    const { document, send } = loadPage(pageHtml(), uiSource);
    send({ type: 'recordLoaded', payload: { profileId: 'p', layout: 'Contacts', record: { recordId: '1', modId: '1', fieldData }, fields, metadataSupported: true } });
    return document.getElementById('hiddenNote');
  };

  it('always says that fields the account cannot access are not shown', () => {
    const note = load({ Name: 'A' }, [{ name: 'Name' }]);
    expect(note?.textContent).toBe('Fields your account has no access to are not shown here.');
    expect(note?.classList.contains('hidden')).toBe(false);
  });

  it('counts and names layout fields that the record has no value for', () => {
    const note = load({ Name: 'A' }, [{ name: 'Name' }, { name: 'Email' }]);
    expect(note?.textContent).toMatch(/^1 field on this layout is not shown \(hidden by your account or its privileges\): Email\./);
    const several = load({ Name: 'A' }, [{ name: 'Name' }, ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name }))]);
    expect(several?.textContent).toMatch(/^7 fields on this layout are not shown .*: a, b, c, d, e, and 2 more\./);
  });
});
