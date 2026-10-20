import { afterAll, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { generateSnippet } from '../../src/snippets';
import type { ConnectionProfile } from '../../src/types/fm';
import { ScriptRunnerPanel } from '../../src/webviews/scriptRunner';
import { makeHarness } from './ai/harness';
import { createAxiosResponse, InMemoryMemento, InMemorySecretStorage } from './mocks';
import { cleanupScratch, parseHttpFile, parsePostman, runCurl, runScriptSnippet, transpile, wireFromCurl } from './snippets/checks';
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

  const operations: Record<string, (fm: FMClient, name: string, profile: ConnectionProfile) => Promise<unknown>> = {
    get: (fm, name, profile) => fm.getRecord(profile, name, '1'),
    find: (fm, name, profile) => fm.findRecords(profile, name, { query: [{}] }),
    metadata: (fm, name, profile) => fm.getLayoutMetadata(profile, name),
    edit: (fm, name, profile) => fm.editRecord(profile, name, '1', { Name: 'A' }),
    create: (fm, name, profile) => fm.createRecord(profile, name, { Name: 'A' }),
    delete: (fm, name, profile) => fm.deleteRecord(profile, name, '1'),
    'container layout': (fm, name, profile) => fm.uploadContainer(profile, name, '1', 'Photo', { fileName: 'x', content: Buffer.from('x') }),
    'container field': (fm, name, profile) => fm.uploadContainer(profile, 'L', '1', name, { fileName: 'x', content: Buffer.from('x') }),
    'script layout': (fm, name, profile) => fm.runScript(profile, { layout: name, scriptName: 'S' }),
    script: (fm, name, profile) => fm.runScript(profile, { layout: 'L', scriptName: name })
  };
  for (const [operation, invoke] of Object.entries(operations)) {
    for (const profile of [directProfile, proxyProfile]) {
      it.each(['.', '..'])(`${profile.authMode} ${operation}: refuses %s with no request, including login`, async (name) => {
        const { fm, request } = client();
        await expect(invoke(fm, name, profile)).rejects.toMatchObject({ code: 'NAME_NOT_USABLE_IN_URL', kind: 'validation', isRetryable: false });
        expect(request).not.toHaveBeenCalled();
      });
    }
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

  it.each(['/fmi/my%20path', '/prefix[x]/{data}/'])('copy keeps the configured API base path %s identical to the client', async (apiBasePath) => {
    const profile = { ...directProfile, apiBasePath };
    const { fm, request, secretStore } = client();
    await secretStore.setSessionToken(profile.id, 'tok');
    await fm.listLayouts(profile);
    const url = `${profile.serverUrl}${apiBasePath.replace(/\/$/, '')}/vLatest/databases/Sales%20DB/layouts`;
    expect(request.mock.calls[0]?.[0].url).toBe(url);
    const copy = (format: 'curl' | 'fetch' | 'typescript' | 'http' | 'postman') => generateSnippet(profile, { kind: 'listLayouts' }, format);
    const wires = [
      wireFromCurl(runCurl(copy('curl')).args),
      (await runScriptSnippet(copy('fetch'))).wire,
      (await runScriptSnippet(transpile(copy('typescript')))).wire,
      parseHttpFile(copy('http')).wire,
      parsePostman(copy('postman')).wire
    ];
    for (const wire of wires) expect(wire.url).toBe(url);
  });

  it.each(['/prefix[x]/', '/{data}/', "/fmi/it's$(echo unsafe)[x]/{data}"])(
    'curl receives one unchanged URL with globbing disabled for %s', (apiBasePath) => {
      const text = generateSnippet({ ...directProfile, apiBasePath }, { kind: 'listLayouts' }, 'curl');
      const { args, stderr } = runCurl(text);
      const url = `${directProfile.serverUrl}${apiBasePath.replace(/\/$/, '')}/vLatest/databases/Sales%20DB/layouts`;
      expect(stderr).toBe('');
      expect(args).toContain('--globoff');
      expect(args.filter((arg) => arg.startsWith('https://'))).toEqual([url]);
      expect(wireFromCurl(args).url).toBe(url);
    }
  );
});
