import { afterAll, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { generateSnippet } from '../../src/snippets';
import type { SnippetOperation } from '../../src/snippets/model';
import { ScriptRunnerPanel } from '../../src/webviews/scriptRunner';
import { makeHarness } from './ai/harness';
import { createAxiosResponse, InMemoryMemento, InMemorySecretStorage } from './mocks';
import { cleanupScratch, runScriptSnippet, transpile } from './snippets/checks';
import { directProfile, proxyProfile } from './snippets/fixtures';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const scriptResponse = { scriptResult: '  exact answer  ', scriptError: '0', 'scriptResult.prerequest': 'before' };
function client() {
  const request = vi.fn().mockResolvedValue(createAxiosResponse({ data: {
    response: { ...scriptResponse, data: [{ fieldData: { Secret: 'private-record' } }], dataInfo: { foundCount: 1 } },
    messages: [{ code: '0', message: 'OK' }]
  } }));
  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  const fm = new FMClient(secretStore, logger, 3000, { request } as never);
  return { fm, request, secretStore };
}

afterAll(cleanupScratch);

describe('release hardening', () => {
  it('plain script GET drops record data before the client, AI tool and Script Runner see it', async () => {
    const { fm, request, secretStore } = client();
    await secretStore.setSessionToken(directProfile.id, 'tok');
    const result = await fm.runScript(directProfile, { layout: 'Contacts', scriptName: 'Echo' });
    expect(result.response).toEqual(scriptResponse);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ method: 'GET', url: expect.stringContaining('/script/Echo') });

    const h = makeHarness({ settings: { scriptAllowlist: { p1: ['Echo'] } } });
    h.client.listScripts.mockResolvedValue(['Echo']);
    h.client.runScript.mockImplementation((_p, r) => fm.runScript(directProfile, r));
    h.confirm.mockResolvedValue(true);
    h.state.now += 120_000;
    const aiResult = await h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Echo' });
    expect(JSON.stringify(aiResult)).not.toMatch(/private-record|dataInfo|fieldData/);
    expect(JSON.stringify(aiResult)).toContain('  exact answer  ');

    let receive: ((message: unknown) => void) | undefined;
    const posted: Record<string, unknown>[] = [];
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
      webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u,
        postMessage: vi.fn(async (m: Record<string, unknown>) => { posted.push(m); return true; }),
        onDidReceiveMessage: (cb: (m: unknown) => void) => { receive = cb; return { dispose() {} }; } },
      onDidDispose: vi.fn(() => ({ dispose() {} })), reveal() {}, dispose() {}
    } as never);
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
    ScriptRunnerPanel.createOrShow(
      { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
      { listProfiles: async () => [directProfile], getProfile: async () => directProfile, getActiveProfileId: () => directProfile.id } as never,
      { listLayouts: async () => ['Contacts'], listScripts: async () => ['Echo'], runScript: (p: typeof directProfile, r: never) => fm.runScript(p, r) } as never,
      logger as never
    );
    receive?.({ type: 'runScript', payload: { profileId: directProfile.id, layout: 'Contacts', scriptName: 'Echo' } });
    await expect.poll(() => posted.some((m) => m.type === 'scriptResult')).toBe(true);
    expect(JSON.stringify(posted)).not.toMatch(/private-record|dataInfo|fieldData/);
    expect(JSON.stringify(posted)).toContain('  exact answer  ');
  });

  const operations: Record<string, (fm: FMClient, name: string) => Promise<unknown>> = {
    get: (fm, name) => fm.getRecord(directProfile, name, '1'),
    find: (fm, name) => fm.findRecords(directProfile, name, { query: [{}] }),
    metadata: (fm, name) => fm.getLayoutMetadata(directProfile, name),
    edit: (fm, name) => fm.editRecord(directProfile, name, '1', { Name: 'A' }),
    create: (fm, name) => fm.createRecord(directProfile, name, { Name: 'A' }),
    delete: (fm, name) => fm.deleteRecord(directProfile, name, '1'),
    'container layout': (fm, name) => fm.uploadContainer(directProfile, name, '1', 'Photo', { fileName: 'x', content: Buffer.from('x') }),
    'container field': (fm, name) => fm.uploadContainer(directProfile, 'L', '1', name, { fileName: 'x', content: Buffer.from('x') }),
    'script layout': (fm, name) => fm.runScript(directProfile, { layout: name, scriptName: 'S' }),
    script: (fm, name) => fm.runScript(directProfile, { layout: 'L', scriptName: name })
  };
  for (const [operation, invoke] of Object.entries(operations)) {
    it.each(['.', '..'])(`${operation}: refuses %s with no request, including login`, async (name) => {
      const { fm, request } = client();
      await expect(invoke(fm, name)).rejects.toMatchObject({ code: 'NAME_NOT_USABLE_IN_URL', kind: 'validation', isRetryable: false });
      expect(request).not.toHaveBeenCalled();
    });
  }

  it.each([' .', '.. ', 'a..b', '...', ' Layout/ü '])('keeps usable names exactly: %s', async (layout) => {
    const { fm, request, secretStore } = client();
    await secretStore.setSessionToken(directProfile.id, 'tok');
    await fm.getLayoutMetadata(directProfile, layout);
    expect(request.mock.calls[0]?.[0].url).toContain(`/layouts/${encodeURIComponent(layout)}`);
  });

  it('TypeScript copy preserves an own __proto__ field when executed', async () => {
    const fieldData = JSON.parse('{"__proto__":"keep exactly","Name":"Ada"}') as Record<string, unknown>;
    const text = generateSnippet(directProfile, { kind: 'createRecord', layout: 'L', fieldData }, 'typescript');
    const { wire } = await runScriptSnippet(transpile(text));
    const body = JSON.parse(wire.body ?? '{}') as { fieldData: Record<string, unknown> };
    expect(Object.hasOwn(body.fieldData, '__proto__')).toBe(true);
    expect(body.fieldData['__proto__']).toBe('keep exactly');
  });

  it('copy preserves a trailing slash on the proxy endpoint in every format', () => {
    const profile = { ...proxyProfile, proxyEndpoint: 'https://proxy.example.com/api/' };
    for (const format of ['curl', 'fetch', 'typescript', 'http', 'postman'] as const) {
      expect(generateSnippet(profile, { kind: 'listLayouts' }, format)).toContain('/api/');
    }
  });

  it('copy encodes every apiBasePath segment so curl cannot glob brackets or braces', () => {
    const profile = { ...directProfile, apiBasePath: '/prefix[x]/{data}/' };
    const op: SnippetOperation = { kind: 'listLayouts' };
    for (const format of ['curl', 'fetch', 'typescript', 'http', 'postman'] as const) {
      const text = generateSnippet(profile, op, format);
      expect(text).toContain('/prefix%5Bx%5D/%7Bdata%7D/vLatest/databases/');
      expect(text).not.toContain('/prefix[x]/{data}/');
    }
  });
});
