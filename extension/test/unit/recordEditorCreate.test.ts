import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { FMClient } from '../../src/services/fmClient';
import { SchemaService } from '../../src/services/schemaService';
import { SecretStore } from '../../src/services/secretStore';
import { RecordEditorPanel } from '../../src/webviews/recordEditor';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const workspace = vscode.workspace as unknown as { isTrusted: boolean; getConfiguration: ReturnType<typeof vi.fn> };

const profile = (serverUrl: string) => ({
  id: 'p1',
  name: 'Mock',
  authMode: 'direct' as const,
  serverUrl,
  database: 'Sales',
  username: 'tester',
  apiBasePath: '/fmi/data',
  apiVersionPath: 'vLatest'
});

function openPanel(deps: { profileStore: unknown; fmClient: unknown; schemaService: unknown }) {
  const handlers: Array<(message: unknown) => void> = [];
  const posted: Array<{ type?: string; message?: string; payload?: Record<string, unknown> }> = [];
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'csp',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message: never) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        handlers.push(handler);
        return { dispose: vi.fn() };
      }
    },
    reveal: vi.fn(),
    onDidDispose: vi.fn()
  } as never);
  (RecordEditorPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  RecordEditorPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' } } as never,
    deps.profileStore as never,
    deps.fmClient as never,
    deps.schemaService as never,
    logger,
    { mode: 'create' }
  );
  return {
    posted,
    send: async (message: unknown) => {
      const before = posted.length;
      handlers.forEach((handler) => handler(message));
      for (let i = 0; i < 200 && posted.length === before; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    last: (type: string) => [...posted].reverse().find((m) => m.type === type)
  };
}

describe('Record Editor create mode (stubbed services)', () => {
  const fields = [{ name: 'Name' }, { name: 'Age' }];
  let createRecord: ReturnType<typeof vi.fn>;
  let panel: ReturnType<typeof openPanel>;

  beforeEach(() => {
    vi.clearAllMocks();
    workspace.isTrusted = true;
    workspace.getConfiguration.mockImplementation(() => ({ get: (_k: string, d?: unknown) => d }));
    createRecord = vi.fn(async () => ({ recordId: '501', modId: '0', response: {}, messages: [] }));
    panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord },
      schemaService: { getFields: vi.fn(async () => ({ supported: true, fields, fromCache: false })) }
    });
  });

  const create = { type: 'createRecord', payload: { profileId: 'p1', layout: 'People', fieldData: { Name: 'Ada', Age: 36, Blank: '' } } };

  it.each([undefined, 'Cancel', 'Remove the character and continue'])('handles NUL before creating: %s', async (choice) => {
    vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValueOnce(choice as never).mockResolvedValueOnce('Create' as never);
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: 'A\0B\u200bC\ufeffD' } } });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Name'), { modal: true }, 'Remove the character and continue', 'Cancel'
    );
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toContain('FileMaker keeps only the text before this character and drops the rest.');
    if (choice === 'Remove the character and continue') {
      expect(createRecord).toHaveBeenCalledWith(expect.anything(), 'People', { Name: 'AB\u200bC\ufeffD' });
    } else {
      expect(createRecord).not.toHaveBeenCalled();
      expect(panel.last('saveCancelled')).toBeDefined();
    }
  });

  it('lists the layout fields without any record id', async () => {
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'People' } });
    expect(panel.last('layoutFields')?.payload).toMatchObject({ metadataSupported: true, fields: [{ name: 'Name' }, { name: 'Age' }] });
  });

  it('refuses names that are not fields of the layout, before asking or calling FileMaker', async () => {
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'People' } });
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: 'Ada', Extra: 'x' } } });
    expect(panel.last('error')?.message).toMatch(/not fields on layout "People": Extra/);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('creates after confirmation (empty values dropped) and shows the id', async () => {
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'People' } });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: 'Ada', Age: '' } } });
    expect(createRecord).toHaveBeenCalledWith(expect.anything(), 'People', { Name: 'Ada' });
    expect(panel.last('recordCreated')?.payload).toMatchObject({ recordId: '501', layout: 'People' });
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[1]).toMatchObject({ modal: true });
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: 'Ada' } } });
    expect(createRecord).not.toHaveBeenCalled();
    expect(panel.last('saveCancelled')).toBeDefined();
  });

  it('refuses an empty form, malformed payloads, offline mode, and a user switch-off of record editing', async () => {
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: '' } } });
    expect(panel.last('error')?.message).toMatch(/At least one field/);

    const before = panel.posted.length;
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', layout: 'People', fieldData: [1] } });
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', fieldData: { a: 1 } } });
    expect(panel.posted.length).toBe(before); // unparsable messages are ignored
    expect(createRecord).not.toHaveBeenCalled();

    workspace.getConfiguration.mockImplementation(() => ({
      get: (_k: string, d?: unknown) => d,
      inspect: (key: string) => (key === 'features.recordEdit.enabled' ? { defaultValue: true, globalValue: false } : undefined)
    }));
    await panel.send(create);
    expect(panel.last('error')?.message).toMatch(/features\.recordEdit\.enabled/);

    workspace.getConfiguration.mockImplementation(() => ({
      get: (_k: string, d?: unknown) => d,
      inspect: (key: string) => (key === 'offline.mode' ? { defaultValue: false, globalValue: true } : undefined)
    }));
    await panel.send(create);
    expect(panel.last('error')?.message).toMatch(/Offline mode/);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('refuses in an untrusted workspace', async () => {
    workspace.isTrusted = false;
    await panel.send(create);
    expect(panel.last('error')?.message).toMatch(/untrusted workspaces/);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('shows the field list and form controls for create mode in the page', () => {
    const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
    expect(html).toContain('id="createButton"');
    expect(html).toContain('id="recordIdRow"');
  });
});

describe('Record Editor create mode against the mock FileMaker server', () => {
  let child: ChildProcess;
  let base = '';

  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(free));
      });
    });
    child = spawn(process.execPath, [path.resolve(__dirname, '../mock-server/server.mjs')], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore'
    });
    base = `http://127.0.0.1:${port}`;
    nock.enableNetConnect('127.0.0.1');
    for (let i = 0; i < 100; i += 1) {
      try {
        await fetch(`${base}/__admin/reset`, { method: 'POST' });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error('mock server did not start');
  }, 20_000);

  afterAll(() => {
    child?.kill();
    nock.disableNetConnect();
  });

  afterEach(() => {
    workspace.isTrusted = true;
  });

  it('lists the fields, creates a record through the real client, and the record exists', async () => {
    workspace.isTrusted = true;
    workspace.getConfiguration.mockImplementation(() => ({ get: (_k: string, d?: unknown) => d }));
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'testpass1');
    const fmClient = new FMClient(secrets, { debug() {}, info() {}, warn() {}, error() {} } as never, 5000);
    const schemaService = new SchemaService(fmClient, { debug() {}, info() {}, warn() {}, error() {} });
    const p = profile(base);
    const panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => p), listProfiles: vi.fn(async () => [p]), getActiveProfileId: vi.fn(() => 'p1') },
      fmClient,
      schemaService
    });

    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'Contacts' } });
    const listed = panel.last('layoutFields')?.payload as { fields: Array<{ name: string }> };
    expect(listed.fields.map((f) => f.name)).toContain('Email');

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send({
      type: 'createRecord',
      payload: { profileId: 'p1', layout: 'Contacts', fieldData: { FirstName: 'Created', Email: 'created@example.test', Notes: '' } }
    });

    const created = panel.last('recordCreated')?.payload as { recordId: string };
    expect(created.recordId).toMatch(/^\d+$/);
    const fetched = await fmClient.getRecord(p, 'Contacts', created.recordId);
    expect(fetched.fieldData).toMatchObject({ FirstName: 'Created', Email: 'created@example.test' });

    // A field the layout does not have is refused before FileMaker is asked.
    const errors = panel.posted.filter((m) => m.type === 'error').length;
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', layout: 'Contacts', fieldData: { NoSuchField: 'x' } } });
    expect(panel.posted.filter((m) => m.type === 'error').length).toBe(errors + 1);
  }, 20_000);
});
