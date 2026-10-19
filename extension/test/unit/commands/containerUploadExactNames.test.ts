import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerRecordEditCommands } from '../../../src/commands/recordEdit';
import { FMClient } from '../../../src/services/fmClient';
import { SecretStore } from '../../../src/services/secretStore';
import type { ConnectionProfile } from '../../../src/types/fm';
import { InMemorySecretStorage } from '../mocks';

/**
 * The only UI route to a container upload is this command. A field named ` Photo` on a layout named ` Sales`
 * must reach the server as exactly that, not as `Photo` on `Sales`.
 */
describe('Upload to Container command keeps names exactly', () => {
  const servers: Server[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    const fsMock = vscode.workspace.fs as unknown as { stat: ReturnType<typeof vi.fn>; readFile: ReturnType<typeof vi.fn> };
    fsMock.stat = vi.fn().mockResolvedValue({ size: 4 });
    fsMock.readFile.mockResolvedValue(Buffer.from('data'));
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ fsPath: '/tmp/a.png', path: '/tmp/a.png' } as vscode.Uri]);
  });

  async function run(arg: Record<string, unknown>, typedFieldName?: string) {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        paths.push(`${request.method} ${request.url}`);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ response: { modId: '2' }, messages: [{ code: '0', message: 'OK' }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const profile: ConnectionProfile = { id: 'p1', name: 'T', authMode: 'direct', serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, database: 'Db', username: 'u' };
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    await secrets.setSessionToken('p1', 'tok');
    const fmClient = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, 3000);
    if (typedFieldName !== undefined) {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue(typedFieldName);
    }
    registerRecordEditCommands({
      context: { subscriptions: [], extensionUri: { fsPath: '/ext' } } as never,
      profileStore: { getProfile: async () => profile, listProfiles: async () => [profile], getActiveProfileId: () => 'p1' } as never,
      fmClient: fmClient as never,
      schemaService: {} as never,
      settingsService: { isRecordEditEnabled: () => true, getContainerUploadMaxBytes: () => 1000 } as never,
      roleGuard: { assertFeature: async () => true } as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });
    const command = vi.mocked(vscode.commands.registerCommand).mock.calls.filter(([id]) => id === 'filemakerDataApiTools.uploadContainer').pop()?.[1] as (a: unknown) => Promise<boolean>;
    const done = await command({ profileId: 'p1', layout: ' Sales', recordId: '7', ...arg });
    return { done, uploads: paths.filter((line) => /\/containers\//.test(line)) };
  }

  it('a field given by the caller: layout ` Sales`, field ` Photo`', async () => {
    const { done, uploads } = await run({ fieldName: ' Photo', fieldRepetition: 2 });
    expect(done).toBe(true);
    expect(uploads).toEqual(['POST /fmi/data/vLatest/databases/Db/layouts/%20Sales/records/7/containers/%20Photo/2']);
  });

  it('a field typed in the prompt keeps its leading space too, and the confirmation names it', async () => {
    const { done, uploads } = await run({}, ' Photo');
    expect(done).toBe(true);
    expect(uploads).toEqual(['POST /fmi/data/vLatest/databases/Db/layouts/%20Sales/records/7/containers/%20Photo/1']);
    expect(String(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0])).toContain('to  Photo on record');
  });

  it('a blank field name sends nothing', async () => {
    const { done, uploads } = await run({}, '   ');
    expect(done).toBe(false);
    expect(uploads).toEqual([]);
  });
});
