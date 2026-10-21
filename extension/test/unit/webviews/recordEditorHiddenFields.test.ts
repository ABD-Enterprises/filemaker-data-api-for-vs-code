import { readFileSync } from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { duplicatePhotoMetadata } from '../../fixtures/duplicatePhoto';
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

  it('shows one Photo control with a note when the metadata lists it twice', () => {
    const { document, send } = loadPage(pageHtml(), uiSource);
    send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData: { Photo: 'https://example.test/photo' } }, fields: duplicatePhotoMetadata.fieldMetaData } });
    expect(document.querySelectorAll('#fieldEditor tbody tr')).toHaveLength(1);
    expect(document.getElementById('duplicateFieldNote')?.textContent).toContain('Photo');
    expect(document.getElementById('duplicateFieldNote')?.textContent).toContain('shown once');
    send({ type: 'recordLoaded', payload: { record: { recordId: '2', fieldData: { Photo: '' } }, fields: [{ name: 'Photo' }] } });
    expect(document.getElementById('duplicateFieldNote')?.textContent).toBe('');
  });

  it('shows the duplicate field note in create mode too', () => {
    const { document, send } = loadPage(pageHtml(), uiSource);
    send({ type: 'init', payload: { profiles: [{ id: 'p', name: 'P' }], activeProfileId: 'p', defaults: { mode: 'create', profileId: 'p', layout: 'Contact Details' } } });
    send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: ['Contact Details'] } });
    send({ type: 'layoutFields', payload: { profileId: 'p', layout: 'Contact Details', fields: duplicatePhotoMetadata.fieldMetaData, metadataSupported: true } });
    expect(document.querySelectorAll('#fieldEditor tbody tr')).toHaveLength(1);
    expect(document.getElementById('duplicateFieldNote')?.textContent).toContain('Photo');
    expect(document.getElementById('duplicateFieldNote')?.textContent).toContain('shown once');
  });

  it('says nothing when nothing is missing (the note is hidden and empty)', () => {
    const note = load({ Name: 'A' }, [{ name: 'Name' }]);
    expect(note?.textContent).toBe('');
    expect(note?.classList.contains('hidden')).toBe(true);
    // No field list at all (metadata unavailable) is not evidence that anything is missing.
    expect(load({ Name: 'A' }, [])?.classList.contains('hidden')).toBe(true);
  });

  it('always carries a quiet footnote, because a field the server also leaves out of the layout cannot be named', () => {
    const { document } = loadPage(pageHtml(), uiSource);
    const footnote = document.getElementById('fieldsFootnote');
    expect(footnote?.textContent).toMatch(/cannot see/);
    expect(footnote?.classList.contains('hidden')).toBe(false);
  });

  it('hides the note again when the next record has nothing missing', () => {
    const { document, send } = loadPage(pageHtml(), uiSource);
    const record = (fieldData: Record<string, unknown>) => ({ type: 'recordLoaded', payload: { profileId: 'p', layout: 'C', record: { recordId: '1', modId: '1', fieldData }, fields: [{ name: 'Name' }, { name: 'Email' }], metadataSupported: true } });
    send(record({ Name: 'A' }));
    expect(document.getElementById('hiddenNote')?.classList.contains('hidden')).toBe(false);
    send(record({ Name: 'A', Email: 'a@example.com' }));
    expect(document.getElementById('hiddenNote')?.classList.contains('hidden')).toBe(true);
  });

  it('shows a hostile field name as text, never as markup', () => {
    const hostile = '<img src=x onerror="window.pwned=1"><b>x</b>';
    const { document, send } = loadPage(pageHtml(), uiSource);
    send({ type: 'recordLoaded', payload: { profileId: 'p', layout: 'C', record: { recordId: '1', modId: '1', fieldData: { Name: 'A' } }, fields: [{ name: 'Name' }, { name: hostile }], metadataSupported: true } });
    const note = document.getElementById('hiddenNote');
    expect(note?.textContent).toContain(hostile);
    expect(note?.querySelectorAll('img, b, script')).toHaveLength(0);
    expect(document.querySelectorAll('#hiddenNote *')).toHaveLength(0);
  });

  it('counts and names layout fields that the record has no value for', () => {
    const note = load({ Name: 'A' }, [{ name: 'Name' }, { name: 'Email' }]);
    expect(note?.textContent).toMatch(/^1 field on this layout is not shown \(hidden by your account or its privileges\): Email\./);
    const several = load({ Name: 'A' }, [{ name: 'Name' }, ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name }))]);
    expect(several?.textContent).toMatch(/^7 fields on this layout are not shown .*: a, b, c, d, e, and 2 more\./);
  });
});
