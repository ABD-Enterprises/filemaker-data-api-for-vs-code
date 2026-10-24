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
  it('sends edited text and dates as exact strings, and edited number fields as numbers', () => {
    const { window, document, send, posted } = loadPage(pageHtml(), uiSource);
    send({ type: 'init', payload: { profiles: [{ id: 'p', name: 'Test' }], activeProfileId: 'p' } });
    send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: [' Layout '] } });
    document.getElementById('recordIdInput')!.value = '1';
    send({ type: 'recordLoaded', payload: { profileId: 'p', layout: ' Layout ', record: { recordId: '1', fieldData: { ' Text ': 'before', Number: 1, Date: 'before' } },
      presentationFields: [{ name: ' Text ', type: 'text' }, { name: 'Number', type: 'number' }, { name: 'Date', type: 'date' }] } });
    window.eval(`for (const input of document.querySelectorAll('#fieldEditor textarea')) { input.value = '10.50'; input.dispatchEvent(new Event('input')); }`);
    document.getElementById('previewButton')!.click();
    expect(posted.at(-1)).toMatchObject({ type: 'previewPatch', payload: { layout: ' Layout ', draftFieldData: { ' Text ': '10.50', Number: 10.5, Date: '10.50' } } });
  });

});

it.skipIf(!JSDOM)('keeps prototype-like fields in new-record forms and create payloads', () => {
  const { document, window, posted, send } = loadPage(pageHtml(), uiSource);
  send({ type: 'init', payload: { profiles: [{ id: 'p', name: 'Profile' }], activeProfileId: 'p', defaults: { mode: 'create', profileId: 'p', layout: '__proto__' } } });
  send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: ['__proto__'] } });
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  send({ type: 'layoutFields', payload: { profileId: 'p', layout: '__proto__', fields: names.map((name) => ({ name })), metadataSupported: true } });
  const inputs = document.querySelectorAll('textarea[aria-label]');
  expect(Array.from(inputs).map((input) => input.getAttribute('aria-label'))).toEqual(names.slice().sort());
  for (const input of inputs) {
    input.value = 'value';
    (input as unknown as { dispatchEvent(event: unknown): void }).dispatchEvent(new window.Event('input'));
  }
  document.getElementById('createButton')!.click();
  expect(JSON.parse(JSON.stringify(posted.at(-1)))).toMatchObject({ type: 'createRecord', payload: { fieldData: Object.fromEntries(names.map((name) => [name, 'value'])) } });
});

it.skipIf(!JSDOM).each(['edit', 'create'])('keeps calculated, summary and container fields read-only in %s mode and excludes them from payloads', (mode) => {
  const { document, window, posted, send } = loadPage(pageHtml(), uiSource);
  const fields = [
    { name: ' Name ', type: 'normal', result: 'text' },
    { name: 'Calc', type: ' Calculation ', result: 'number' },
    { name: 'Summary', type: ' SUMMARY ', result: 'number' },
    { name: 'Photo', type: 'normal', result: ' Container ' },
    { name: 'Global', type: 'normal', result: 'text', global: true }
  ];
  send({ type: 'init', payload: { profiles: [{ id: 'p', name: 'Profile' }], activeProfileId: 'p', defaults: { mode, profileId: 'p', layout: ' Layout ' } } });
  send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: [' Layout '] } });
  document.getElementById('recordIdInput')!.value = '1';
  const payload = { profileId: 'p', layout: ' Layout ', fields, presentationFields: fields.map((field) => ({ name: field.name, type: field.result })), metadataSupported: true,
    record: { recordId: '1', modId: '7', fieldData: { ' Name ': 'before', Calc: 1, Summary: 2, Photo: 'url', Global: 'before' } } };
  send({ type: mode === 'create' ? 'layoutFields' : 'recordLoaded', payload });
  const notes: Record<string, string> = { Calc: 'Calculated by FileMaker; cannot be edited', Summary: 'Summary field; cannot be edited', Photo: 'Use Upload to container', Global: 'Session-wide' };
  for (const input of document.querySelectorAll('#fieldEditor textarea')) {
    const name = input.getAttribute('aria-label')!;
    expect(input.getAttribute('disabled')).toBeNull();
    expect(input.getAttribute('readonly') !== null).toBe(['Calc', 'Summary', 'Photo'].includes(name));
    expect(document.querySelectorAll('#fieldEditor .fm-field-control')).toHaveLength(5);
    expect(document.querySelectorAll('#fieldEditor tr[data-fm-width]')).toHaveLength(5);
    if (notes[name]) expect(document.body.textContent).toContain(notes[name]);
  }
  // Dispatch even on read-only controls: their event handlers must not change a draft.
  window.eval(`for (const input of document.querySelectorAll('#fieldEditor textarea')) { input.value = 'after'; input.dispatchEvent(new Event('input')); }`);
  document.getElementById(mode === 'create' ? 'createButton' : 'saveButton')!.click();
  const message = posted.at(-1)!;
  const body = message.payload as Record<string, unknown>;
  expect(body[mode === 'create' ? 'fieldData' : 'draftFieldData']).toEqual({ ' Name ': 'after', Global: 'after' });
  if (mode === 'edit') expect(body.originalFieldData).toEqual({ ' Name ': 'before', Global: 'before' });
  // Reuse the same field names on another load: metadata changes must rebuild read-only controls.
  if (mode === 'edit') {
    send({ type: 'recordLoaded', payload: { ...payload, fields: fields.map((field) => ({ ...field, type: 'normal', result: 'text' })) } });
    expect(document.querySelectorAll('#fieldEditor textarea[readonly]')).toHaveLength(0);
  }
});

it.skipIf(!JSDOM)('uses base metadata for repeated editor keys without changing exact names', () => {
  const { document, window, posted, send } = loadPage(pageHtml(), uiSource);
  send({ type: 'init', payload: { profiles: [{ id: 'p', name: 'P' }], activeProfileId: 'p' } });
  send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: [' Layout '] } });
  document.getElementById('recordIdInput')!.value = '1';
  const fields = [
    { name: ' Calc ', type: ' Calculation ', result: 'number', maxRepeat: 2 },
    { name: 'Summary', type: ' SUMMARY ', maxRepeat: 2 },
    { name: 'Photo', result: ' Container ', maxRepeat: 2 },
    { name: 'Qty', result: ' Number ', maxRepeat: 2 },
    { name: 'Global', global: ' TRUE ', maxRepeat: 2 },
    { name: 'Local', global: ' false ' }
  ];
  send({ type: 'recordLoaded', payload: { profileId: 'p', layout: ' Layout ', fields, metadataSupported: true,
    record: { recordId: '1', fieldData: { ' Calc (1)': 1, ' Calc (2)': 2, 'Summary(2)': 3, 'Photo(1)': 'url', 'Qty(2)': 4, 'Global(2)': 'before', Local: 'before' } } } });
  const inputs = Array.from(document.querySelectorAll('#fieldEditor textarea'));
  expect(inputs.filter((input) => input.getAttribute('readonly') !== null).map((input) => input.getAttribute('aria-label')).sort()).toEqual([' Calc (1)', ' Calc (2)', 'Photo(1)', 'Summary(2)']);
  const globalInput = inputs.find((input) => input.getAttribute('aria-label') === 'Global(2)')!;
  expect(document.getElementById(globalInput.getAttribute('aria-describedby')!)?.textContent).toContain('Session-wide');
  expect(inputs.find((input) => input.getAttribute('aria-label') === 'Local')!.getAttribute('aria-describedby')).toBeNull();
  window.eval(`for (const input of document.querySelectorAll('#fieldEditor textarea')) { input.value = '12'; input.dispatchEvent(new Event('input')); }`);
  document.getElementById('saveButton')!.click();
  expect(posted.at(-1)).toMatchObject({ type: 'saveRecord', payload: {
    originalFieldData: { 'Qty(2)': 4, 'Global(2)': 'before', Local: 'before' },
    draftFieldData: { 'Qty(2)': 12, 'Global(2)': '12', Local: '12' }
  } });
});

it.skipIf(!JSDOM)('warns when record metadata cannot identify read-only fields, and clears the warning after a good load', () => {
  const { document, send } = loadPage(pageHtml(), uiSource);
  const payload = { record: { recordId: '1', fieldData: { Name: 'Ada' } }, fields: [], metadataSupported: false };
  send({ type: 'recordLoaded', payload });
  expect(document.body.textContent).toContain('Read-only fields cannot be identified');
  send({ type: 'recordLoaded', payload: { ...payload, fields: [{ name: 'Name' }], metadataSupported: true } });
  expect(document.body.textContent).not.toContain('Read-only fields cannot be identified');
});
