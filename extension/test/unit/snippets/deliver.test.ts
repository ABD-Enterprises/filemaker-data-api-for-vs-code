import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverSnippet, parseRecordRequestPayload, parseSnippetDelivery, recordOperation } from '../../../src/snippets/deliver';
import { generateSnippet } from '../../../src/snippets';
import { directProfile } from './fixtures';

describe('parseSnippetDelivery', () => {
  it('reads format, destination and the auth opt-in', () => {
    expect(parseSnippetDelivery({ format: 'http', destination: 'editor', includeAuthHeader: true })).toEqual({
      format: 'http',
      destination: 'editor',
      includeAuthHeader: true
    });
    expect(parseSnippetDelivery({ format: 'postman' })).toEqual({ format: 'postman', destination: 'clipboard', includeAuthHeader: false });
  });

  it('uses the fallback format of the two older message types, and refuses an unknown format', () => {
    expect(parseSnippetDelivery({}, 'curl')?.format).toBe('curl');
    expect(parseSnippetDelivery({ format: 'xml' }, 'curl')).toBeUndefined();
    expect(parseSnippetDelivery({}, undefined)).toBeUndefined();
    expect(parseSnippetDelivery({ format: 'curl; rm -rf /' })).toBeUndefined();
    expect(parseSnippetDelivery({ format: 'x'.repeat(100) })).toBeUndefined();
    expect(parseSnippetDelivery({ format: 7 })).toBeUndefined();
  });

  it('refuses a destination that is not clipboard or editor and ignores a non-boolean opt-in', () => {
    expect(parseSnippetDelivery({ format: 'curl', destination: 'file' })).toBeUndefined();
    expect(parseSnippetDelivery({ format: 'curl', includeAuthHeader: 'yes' })?.includeAuthHeader).toBe(false);
  });
});

describe('deliverSnippet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('puts the request on the clipboard and says so', async () => {
    await deliverSnippet(directProfile, { kind: 'getRecord', layout: 'L', recordId: '1' }, { format: 'http', destination: 'clipboard', includeAuthHeader: false });
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      generateSnippet(directProfile, { kind: 'getRecord', layout: 'L', recordId: '1' }, 'http')
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Copied .http request to clipboard.');
  });

  it('opens an unsaved editor for Save as .http file and never writes a file or asks for a path', async () => {
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
    await deliverSnippet(directProfile, { kind: 'listLayouts' }, { format: 'http', destination: 'editor', includeAuthHeader: false });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'http',
      content: generateSnippet(directProfile, { kind: 'listLayouts' }, 'http')
    });
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('uses the language of each format for the editor', async () => {
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
    const expected: Record<string, string> = { curl: 'shellscript', fetch: 'javascript', http: 'http', postman: 'json', typescript: 'typescript' };
    for (const [format, language] of Object.entries(expected)) {
      await deliverSnippet(directProfile, { kind: 'listLayouts' }, { format: format as 'curl', destination: 'editor', includeAuthHeader: false });
      expect(vi.mocked(vscode.workspace.openTextDocument).mock.calls.at(-1)?.[0]).toMatchObject({ language });
    }
  });

  it('copies nothing when the request cannot be built', async () => {
    await expect(
      deliverSnippet({ ...directProfile, serverUrl: 'not a url' }, { kind: 'listLayouts' }, { format: 'curl', destination: 'clipboard', includeAuthHeader: false })
    ).rejects.toThrow('not a valid web address');
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe('record requests', () => {
  const base = { profileId: 'p', layout: 'Contacts', recordId: '42', format: 'curl' };

  it('validates the message of the Record Viewer and Record Editor', () => {
    expect(parseRecordRequestPayload({ ...base, operation: 'get' })).toMatchObject({ kind: 'get', recordId: '42' });
    expect(parseRecordRequestPayload({ ...base, operation: 'edit', draftFieldData: { A: 1 } })?.draftFieldData).toEqual({ A: 1 });
    for (const bad of [
      null,
      { ...base, operation: 'patch' },
      { ...base, operation: 'get', format: 'zip' },
      { ...base, operation: 'get', recordId: '  ' },
      { ...base, operation: 'get', layout: 'x'.repeat(2000) },
      { ...base, operation: 'edit', draftFieldData: [1] },
      { ...base, operation: 'edit', draftFieldData: 'A' },
      { profileId: 'p', operation: 'get', format: 'curl' }
    ]) {
      expect(parseRecordRequestPayload(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('follows the include-auth setting when the message does not say', () => {
    expect(parseRecordRequestPayload({ ...base, operation: 'get' })?.delivery.includeAuthHeader).toBe(false);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({ get: () => true } as never);
    expect(parseRecordRequestPayload({ ...base, operation: 'get' })?.delivery.includeAuthHeader).toBe(true);
    expect(parseRecordRequestPayload({ ...base, operation: 'get', includeAuthHeader: false })?.delivery.includeAuthHeader).toBe(false);
  });

  it('builds get, edit (with a field to fill in when nothing changed) and delete', () => {
    expect(recordOperation('get', 'L', '1')).toEqual({ kind: 'getRecord', layout: 'L', recordId: '1' });
    expect(recordOperation('delete', 'L', '1')).toEqual({ kind: 'deleteRecord', layout: 'L', recordId: '1' });
    expect(recordOperation('edit', 'L', '1', { A: 'x' })).toMatchObject({ kind: 'editRecord', fieldData: { A: 'x' } });
    expect(recordOperation('edit', 'L', '1', {})).toMatchObject({ fieldData: { '<field name>': '<new value>' } });
    expect(recordOperation('edit', 'L', '1')).toMatchObject({ fieldData: { '<field name>': '<new value>' } });
  });
});

describe('names are used exactly as given', () => {
  it('keeps a leading or trailing space in a layout, script or field name', () => {
    const text = generateSnippet(directProfile, { kind: 'runScript', layout: ' Sales ', scriptName: ' Echo ' }, 'curl');
    expect(text).toContain('/layouts/%20Sales%20/script/%20Echo%20');
  });

  it('refuses a layout, script or field called . or .. like the client does', () => {
    for (const operation of [
      { kind: 'find', layout: '..', request: { query: [{}] } },
      { kind: 'runScript', layout: 'L', scriptName: '.' },
      { kind: 'uploadContainer', layout: 'L', recordId: '1', fieldName: '..' }
    ] as const) {
      expect(() => generateSnippet(directProfile, operation as never, 'curl')).toThrow('cannot be used in a request');
    }
  });
});
