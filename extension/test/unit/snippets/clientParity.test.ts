import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../../src/services/fmClient';
import { SecretStore } from '../../../src/services/secretStore';
import { buildRequestSpec } from '../../../src/snippets';
import type { SnippetOperation } from '../../../src/snippets/model';
import { createAxiosResponse, InMemorySecretStorage } from '../mocks';
import { directProfile, hostileStrings } from './fixtures';

/**
 * "Exactly like the client does": the address a copied request uses is compared with the address
 * FMClient itself sends, call by call, for names that need percent-encoding.
 */

class FakeAxios {
  public readonly request = vi.fn(async (config: { url?: string; method?: string; data?: unknown; params?: unknown }) => {
    const isSession = config.method === 'POST' && (config.url ?? '').endsWith('/sessions');
    return createAxiosResponse({
      data: {
        response: isSession
          ? { token: 'a-token' }
          : { data: [{ recordId: '1', modId: '1', fieldData: {} }], layouts: [], scripts: [], recordId: '1', modId: '1', fieldMetaData: [] },
        messages: [{ code: '0', message: 'OK' }]
      }
    });
  });
}

async function clientRequest(operation: SnippetOperation): Promise<{ url: string; method: string; data: unknown; params: unknown }> {
  const axios = new FakeAxios();
  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  await secretStore.setPassword(directProfile.id, 'pw');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new FMClient(secretStore, logger, 15_000, axios as never);

  switch (operation.kind) {
    case 'login':
      await client.createSession(directProfile, { userInitiated: true });
      break;
    case 'find':
      await client.findRecords(directProfile, operation.layout, operation.request);
      break;
    case 'getRecord':
      await client.getRecord(directProfile, operation.layout, operation.recordId);
      break;
    case 'createRecord':
      await client.createRecord(directProfile, operation.layout, operation.fieldData);
      break;
    case 'editRecord':
      await client.editRecord(directProfile, operation.layout, operation.recordId, operation.fieldData, undefined, { modId: '7' });
      break;
    case 'deleteRecord':
      await client.deleteRecord(directProfile, operation.layout, operation.recordId);
      break;
    case 'layoutMetadata':
      await client.getLayoutMetadata(directProfile, operation.layout);
      break;
    case 'listLayouts':
      await client.listLayouts(directProfile);
      break;
    case 'listScripts':
      await client.listScripts(directProfile);
      break;
    case 'uploadContainer':
      await client.uploadContainer(directProfile, operation.layout, operation.recordId, operation.fieldName, { fileName: 'a.txt', content: Buffer.from('x') }, {
        fieldRepetition: operation.fieldRepetition,
        modId: operation.withModId ? '7' : undefined
      });
      break;
    default:
      throw new Error(`not compared: ${operation.kind}`);
  }
  const call = axios.request.mock.calls.at(-1)?.[0];
  if (!call) {
    throw new Error('no request was sent');
  }
  return { url: String(call.url), method: String(call.method), data: call.data, params: call.params };
}

describe('a copied request is the request FMClient sends', () => {
  const strings = hostileStrings('/tmp/unused');
  const names = [...Object.values(strings), 'Plain Layout', 'a/b', '100%', 'Ünïcode ✓'];

  for (const name of names) {
    it(`address, method and body for ${JSON.stringify(name).slice(0, 40)}`, async () => {
      const operations: SnippetOperation[] = [
        { kind: 'find', layout: name, request: { query: [{ [name]: name }], limit: 5, offset: 2 } },
        { kind: 'getRecord', layout: name, recordId: name },
        { kind: 'createRecord', layout: name, fieldData: { [name]: name } },
        { kind: 'editRecord', layout: name, recordId: name, fieldData: { [name]: name } },
        { kind: 'deleteRecord', layout: name, recordId: name },
        { kind: 'layoutMetadata', layout: name },
        { kind: 'uploadContainer', layout: name, recordId: name, fieldName: name, fieldRepetition: 3 }
      ];
      for (const operation of operations) {
        // The client trims names before an upload; the copied request sends what it was given.
        if (operation.kind === 'uploadContainer' && name !== name.trim()) {
          continue;
        }
        const sent = await clientRequest(operation);
        const spec = buildRequestSpec(directProfile, operation);
        expect(`${spec.host}${spec.path}`, operation.kind).toBe(sent.url);
        expect(spec.method, operation.kind).toBe(sent.method);
        if (operation.kind === 'editRecord' && spec.body?.kind === 'json') {
          const body = sent.data as { fieldData: unknown; modId: string };
          expect(JSON.stringify((spec.body.value as { fieldData: unknown }).fieldData), operation.kind).toBe(JSON.stringify(body.fieldData));
        }
      }
    });
  }

  it('the operations without a name: login, list layouts, list scripts', async () => {
    for (const operation of [{ kind: 'login' }, { kind: 'listLayouts' }, { kind: 'listScripts' }] as SnippetOperation[]) {
      const sent = await clientRequest(operation);
      const spec = buildRequestSpec(directProfile, operation);
      expect(`${spec.host}${spec.path}`, operation.kind).toBe(sent.url);
      expect(spec.method, operation.kind).toBe(sent.method);
    }
  });

  it('a server address with a trailing slash, a path prefix and a custom API path is built the same way', async () => {
    const profile = { ...directProfile, serverUrl: 'https://fm.example.com/prefix//', apiBasePath: 'custom/data/', apiVersionPath: '/v2/' };
    const axios = new FakeAxios();
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    await secretStore.setPassword(profile.id, 'pw');
    const client = new FMClient(secretStore, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 15_000, axios as never);
    await client.listLayouts(profile);
    const sent = String(axios.request.mock.calls.at(-1)?.[0]?.url);
    const spec = buildRequestSpec(profile, { kind: 'listLayouts' });
    expect(`${spec.host}${spec.path}`).toBe(sent);
  });
});
