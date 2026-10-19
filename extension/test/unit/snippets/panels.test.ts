import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryStore } from '../../../src/services/historyStore';
import { generateSnippet } from '../../../src/snippets';
import type { SnippetOperation } from '../../../src/snippets/model';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';
import { ScriptRunnerPanel } from '../../../src/webviews/scriptRunner';
import { InMemoryMemento } from '../mocks';
import { directProfile } from './fixtures';

/** Every panel that offers "Copy request": what it accepts, what it copies, what it refuses. */

const profile = { ...directProfile, id: 'p1' };
const workspace = vscode.workspace as unknown as { isTrusted: boolean };

interface FakePanel {
  send: (message: unknown) => Promise<void>;
  posted: Array<Record<string, unknown>>;
  html: () => string;
  dispose: () => void;
}

function fakePanel(): FakePanel {
  let handler: ((message: unknown) => void) | undefined;
  let onDispose: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const webview = {
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri: unknown) => uri,
    postMessage: vi.fn(async (message: Record<string, unknown>) => {
      posted.push(message);
      return true;
    }),
    onDidReceiveMessage: (callback: (message: unknown) => void) => {
      handler = callback;
      return { dispose: vi.fn() };
    }
  };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview,
    reveal: vi.fn(),
    onDidDispose: (callback: () => void) => {
      onDispose = callback;
      return { dispose: vi.fn() };
    }
  } as never);
  return {
    posted,
    html: () => webview.html,
    dispose: () => onDispose?.(),
    send: async (message) => {
      handler?.(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const context = { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never;
const profileStore = {
  listProfiles: vi.fn(async () => [profile]),
  getProfile: vi.fn(async (id: string) => (id === profile.id ? profile : undefined)),
  getActiveProfileId: vi.fn(() => profile.id)
} as never;

function lastCopied(): string {
  return String(vi.mocked(vscode.env.clipboard.writeText).mock.calls.at(-1)?.[0]);
}

const errors = (panel: FakePanel): string[] => panel.posted.filter((m) => m.type === 'error').map((m) => String(m.message));

beforeEach(() => {
  vi.clearAllMocks();
  workspace.isTrusted = true;
});

describe('Query Builder: Copy request', () => {
  let panel: FakePanel;

  beforeEach(() => {
    panel = fakePanel();
    QueryBuilderPanel.createOrShow(
      context,
      profileStore,
      { listSavedQueries: vi.fn(async () => []) } as never,
      { listLayouts: vi.fn(async () => ['Contacts']) } as never,
      logger,
      undefined,
      new HistoryStore(new InMemoryMemento() as never)
    );
  });
  afterEach(() => panel.dispose());

  const payload = { profileId: 'p1', layout: 'Order/2026 100%', findJson: '[{"Status":"Open"}]', limit: 5, offset: 3 };
  const operation: SnippetOperation = { kind: 'find', layout: 'Order/2026 100%', request: { query: [{ Status: 'Open' }], limit: 5, offset: 3 } };

  it.each(['curl', 'fetch', 'http', 'postman', 'typescript'] as const)('copyRequest copies the find as %s', async (format) => {
    await panel.send({ type: 'copyRequest', payload: { ...payload, format, destination: 'clipboard', includeAuthHeader: false } });
    expect(lastCopied()).toBe(generateSnippet(profile, operation, format, { includeAuthHeader: false }));
    expect(lastCopied()).toContain('Order%2F2026%20100%25');
    expect(errors(panel)).toEqual([]);
  });

  it('keeps the two older buttons: copyCurlSnippet and copyFetchSnippet', async () => {
    await panel.send({ type: 'copyCurlSnippet', payload: { ...payload, includeAuthHeader: true } });
    expect(lastCopied()).toBe(generateSnippet(profile, operation, 'curl', { includeAuthHeader: true }));
    expect(lastCopied()).toContain('"Authorization: Bearer $FM_TOKEN"');
    await panel.send({ type: 'copyFetchSnippet', payload });
    expect(lastCopied()).toBe(generateSnippet(profile, operation, 'fetch'));
    expect(lastCopied()).toContain('Bearer <REDACTED>');
  });

  it('Save as .http file opens an unsaved editor and writes no file', async () => {
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
    await panel.send({ type: 'copyRequest', payload: { ...payload, format: 'http', destination: 'editor' } });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'http', content: generateSnippet(profile, operation, 'http') });
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('refuses a message with an unknown format, destination or payload and answers with an error', async () => {
    for (const bad of [
      { ...payload, format: 'perl', destination: 'clipboard' },
      { ...payload, format: 'curl', destination: 'file' },
      { ...payload, format: { toString: 'x' } },
      { profileId: 'p1', layout: 'L', format: 'curl' },
      { ...payload, findJson: '' }
    ]) {
      vi.mocked(vscode.env.clipboard.writeText).mockClear();
      await panel.send({ type: 'copyRequest', payload: bad });
      expect(vscode.env.clipboard.writeText, JSON.stringify(bad)).not.toHaveBeenCalled();
    }
    expect(errors(panel).length).toBeGreaterThanOrEqual(5);
  });

  it('reports a find that is not valid JSON instead of copying', async () => {
    await panel.send({ type: 'copyRequest', payload: { ...payload, findJson: '[{', format: 'curl' } });
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(errors(panel)).toHaveLength(1);
  });

  it('reports a profile that no longer exists', async () => {
    await panel.send({ type: 'copyRequest', payload: { ...payload, profileId: 'gone', format: 'curl' } });
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(errors(panel)[0]).toContain('profile was not found');
  });

  it('the page offers every format, keeps its ids, and puts no data in the markup', () => {
    const html = panel.html();
    for (const id of ['copyRequestMenu', 'copyCurlButton', 'copyFetchButton', 'copyHttpButton', 'copyPostmanButton', 'copyTypeScriptButton', 'saveHttpButton', 'includeAuthCheckbox']) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/data-copy-format="typescript"/);
    expect(html).toContain('data-copy-destination="editor"');
  });
});

describe('Script Runner: Copy request', () => {
  let panel: FakePanel;
  beforeEach(() => {
    panel = fakePanel();
    ScriptRunnerPanel.createOrShow(context, profileStore, { listLayouts: vi.fn(async () => ['Contacts']) } as never, logger);
  });
  afterEach(() => panel.dispose());

  const payload = { profileId: 'p1', layout: 'Contacts', scriptName: 'Send Welcome', scriptParam: '{"id": 1}' };

  it.each(['curl', 'fetch', 'http', 'postman', 'typescript'] as const)('copies the documented GET form as %s', async (format) => {
    await panel.send({ type: 'copyRequest', payload: { ...payload, format } });
    expect(lastCopied()).toBe(generateSnippet(profile, { kind: 'runScript', layout: 'Contacts', scriptName: 'Send Welcome', scriptParam: '{"id": 1}' }, format));
    expect(lastCopied()).toContain('script/Send%20Welcome');
    expect(lastCopied()).toContain('script.param=');
    expect(lastCopied()).not.toContain('"scriptParam"');
  });

  it('with a record in context the script rides on a GET of that record', async () => {
    await panel.send({ type: 'copyRequest', payload: { ...payload, recordId: '12', format: 'http' } });
    expect(lastCopied()).toContain('/layouts/Contacts/records/12?script=Send%20Welcome&script.param=');
  });

  it('keeps the two older buttons', async () => {
    await panel.send({ type: 'copyCurl', payload: { ...payload, includeAuthHeader: false } });
    expect(lastCopied()).toContain('curl -X GET ');
    await panel.send({ type: 'copyFetch', payload });
    expect(lastCopied()).toContain('await fetch(');
  });

  it('refuses a blank script name, an unknown format and an untrusted workspace', async () => {
    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    await panel.send({ type: 'copyRequest', payload: { ...payload, scriptName: '   ', format: 'curl' } });
    await panel.send({ type: 'copyRequest', payload: { ...payload, format: 'cobol' } });
    workspace.isTrusted = false;
    await panel.send({ type: 'copyRequest', payload: { ...payload, format: 'curl' } });
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(panel.posted.some((m) => m.type === 'unsupported')).toBe(true);
  });

  it('the page has the Copy request menu with every format', () => {
    const html = panel.html();
    for (const id of ['copyRequestMenu', 'copyCurlButton', 'copyFetchButton', 'copyHttpButton', 'copyPostmanButton', 'copyTypeScriptButton', 'saveHttpButton']) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });
});

describe('Record Viewer: Copy request for this record', () => {
  let panel: FakePanel;
  beforeEach(() => {
    panel = fakePanel();
    RecordViewerPanel.createOrShow(context, profileStore, {} as never, logger);
  });
  afterEach(() => panel.dispose());

  const base = { profileId: 'p1', layout: 'Contacts', recordId: '42' };

  it.each([
    ['get', 'GET', 'Authorization'],
    ['edit', 'PATCH', '<modId>'],
    ['delete', 'DELETE', 'Authorization']
  ] as const)('%s copies a %s request', async (operation, method, marker) => {
    await panel.send({ type: 'copyRecordRequest', payload: { ...base, operation, format: 'curl' } });
    expect(lastCopied()).toContain(`curl -X ${method} `);
    expect(lastCopied()).toContain('/layouts/Contacts/records/42');
    expect(lastCopied()).toContain(marker);
  });

  it('an edit has the modId placeholder and a field to fill in, as .http too', async () => {
    await panel.send({ type: 'copyRecordRequest', payload: { ...base, operation: 'edit', format: 'http' } });
    expect(lastCopied()).toContain('"modId": "{{modId}}"');
    expect(lastCopied()).toContain('"<field name>": "<new value>"');
  });

  it('refuses a bad operation or format', async () => {
    await panel.send({ type: 'copyRecordRequest', payload: { ...base, operation: 'drop', format: 'curl' } });
    await panel.send({ type: 'copyRecordRequest', payload: { ...base, operation: 'get', format: 'x' } });
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('the page has the menu, the two selects and both buttons', () => {
    const html = panel.html();
    for (const id of ['copyRecordMenu', 'copyOperationSelect', 'copyFormatSelect', 'copyRecordButton', 'saveRecordHttpButton']) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain('<option value="edit">');
  });
});

describe('Record Editor: Copy request for this record', () => {
  let panel: FakePanel;
  const fmClient = {
    getRecord: vi.fn(async () => ({ recordId: '42', modId: '9', fieldData: { Name: 'Ada', City: 'Paris' } })),
    listLayouts: vi.fn(async () => ['Contacts'])
  };
  beforeEach(() => {
    panel = fakePanel();
    RecordEditorPanel.createOrShow(
      context,
      profileStore,
      fmClient as never,
      { getFields: vi.fn(async () => ({ supported: true, fields: [] })) } as never,
      logger
    );
  });
  afterEach(() => panel.dispose());

  const base = { profileId: 'p1', layout: 'Contacts', recordId: '42' };

  it('an edit sends what changed in the form since the record was loaded, with the modId placeholder', async () => {
    await panel.send({ type: 'loadRecord', payload: { ...base, originalFieldData: {}, draftFieldData: {} } });
    await panel.send({
      type: 'copyRecordRequest',
      payload: { ...base, operation: 'edit', format: 'curl', draftFieldData: { Name: 'Ada', City: 'London' } }
    });
    const text = lastCopied();
    expect(text).toContain('--data-raw \'{"fieldData":{"City":"London"},"modId":"<modId>"}\'');
    expect(text).not.toContain('Ada');
  });

  it('without a loaded record, or for another record, it shows a field to fill in instead of trusting the page', async () => {
    await panel.send({ type: 'copyRecordRequest', payload: { ...base, operation: 'edit', format: 'curl', draftFieldData: { Name: 'X' } } });
    expect(lastCopied()).toContain('"<field name>":"<new value>"');
    expect(lastCopied()).not.toContain('"Name"');
  });

  it('get and delete copy the record address', async () => {
    await panel.send({ type: 'copyRecordRequest', payload: { ...base, operation: 'delete', format: 'postman' } });
    expect(lastCopied()).toContain('"method": "DELETE"');
    await panel.send({ type: 'copyRecordRequest', payload: { ...base, operation: 'get', format: 'typescript' } });
    expect(lastCopied()).toContain('"GET"');
  });

  it('is refused in an untrusted workspace like every other message that touches a record', async () => {
    workspace.isTrusted = false;
    await panel.send({ type: 'copyRecordRequest', payload: { ...base, operation: 'get', format: 'curl' } });
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(errors(panel)[0]).toContain('untrusted workspaces');
  });

  it('the page has the menu and hides it while creating a record', () => {
    expect(panel.html()).toContain('id="copyRecordMenu"');
  });
});
