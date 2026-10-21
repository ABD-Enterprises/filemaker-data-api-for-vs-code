import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInNewContext } from 'vm';
import * as ts from 'typescript6';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TypeGenService } from '../../src/services/typeGenService';

describe('generated client responses (stub fetch, no sockets)', () => {
  let root: string;
  let makeClient: (fetch: typeof globalThis.fetch) => { findContacts(request: unknown): Promise<unknown>; createContacts(data: unknown): Promise<unknown> };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'fm-client-errors-'));
    const service = new TypeGenService({ getLayoutSchema: async () => ({ supported: true, fields: [] }) } as never,
      {} as never, { debug() {}, info() {}, warn() {}, error() {} });
    const artifacts = await service.generateTypeScriptClient({ id: 'p', name: 'Test', database: 'DB' } as never, ['Contacts'], root);
    const source = await readFile(artifacts.clientPath, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const exports: Record<string, new (config: unknown) => ReturnType<typeof makeClient>> = {};
    runInNewContext(compiled.outputText, { exports });
    makeClient = (fetch) => new exports.FileMakerDataApiClient!({ serverUrl: 'https://fm.example', database: 'DB', token: 'token', fetch });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it.each([200, 404, 500])('returns an empty find for FileMaker 401 on HTTP %s', async (status) => {
    const client = makeClient(async () => new Response(JSON.stringify({ response: { data: [], dataInfo: { foundCount: 157 } }, messages: [{ code: '401', message: 'No records match the request' }] }), { status }));
    expect(await client.findContacts({ query: [{ Name: '*' }], offset: 158 })).toEqual([]);
    await expect(client.createContacts({})).rejects.toMatchObject({ code: '401', status });
  });

  it.each([200, 500])('exposes FileMaker code, HTTP status and messages for 102 on HTTP %s', async (status) => {
    const messages = [{ code: '102', message: 'Field is missing' }];
    const client = makeClient(async () => new Response(JSON.stringify({ response: {}, messages }), { status }));
    await expect(client.findContacts({ query: [{ Name: '*' }] })).rejects.toMatchObject({ code: '102', status, messages });
  });

  it.each([200, 502])('explains an HTML response on HTTP %s', async (status) => {
    const client = makeClient(async () => new Response('<html>Bad gateway</html>', { status }));
    await expect(client.findContacts({ query: [{ Name: '*' }] })).rejects.toMatchObject({ status, messages: [], message: expect.stringMatching(/not.*Data API JSON.*check/i) });
  });
});
