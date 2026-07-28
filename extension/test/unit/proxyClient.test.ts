import { describe, it, expect, vi } from 'vitest';
import nock from 'nock';

import { ProxyClient } from '../../src/services/proxyClient';
import * as tlsAgent from '../../src/services/tlsAgent';
import type { ConnectionProfile } from '../../src/types/fm';

const PROXY_URL = 'https://proxy.example.com';
const PROXY_PATH = '/api/filemaker';

function createProfile(overrides?: Partial<ConnectionProfile>): ConnectionProfile {
  return {
    id: 'test-proxy',
    name: 'Test Proxy',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    authMode: 'proxy',
    proxyEndpoint: `${PROXY_URL}${PROXY_PATH}`,
    ...overrides
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createSecretStore() {
  return {
    getProxyApiKey: vi.fn().mockResolvedValue('test-api-key'),
    getPassword: vi.fn().mockResolvedValue(undefined),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
    setProxyApiKey: vi.fn(),
    deleteProxyApiKey: vi.fn(),
    clearProfileSecrets: vi.fn()
  };
}

function createClient(secretStore?: ReturnType<typeof createSecretStore>) {
  return new ProxyClient(secretStore ?? createSecretStore(), createLogger(), 5000);
}

class FakeAxios {
  public readonly post = vi.fn();
}

describe('ProxyClient', () => {
  describe('createSession', () => {
    it('returns the session token from the proxy', async () => {
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'createSession')
        .reply(200, { ok: true, data: { token: 'abc-session' } });

      const client = createClient();
      const token = await client.createSession(createProfile());

      expect(token).toBe('abc-session');
      scope.done();
    });

    it('throws on proxy error response', async () => {
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'createSession')
        .reply(200, { ok: false, error: 'Invalid credentials' });

      const client = createClient();
      await expect(client.createSession(createProfile())).rejects.toThrow('Invalid credentials');
      scope.done();
    });

    it('passes per-profile TLS overrides to the proxy HTTPS request', async () => {
      const agentSpy = vi.spyOn(tlsAgent, 'createHttpsAgentForProfile');
      const httpClient = new FakeAxios();
      httpClient.post.mockResolvedValue({ data: { ok: true, data: { token: 'abc-session' } } });
      const client = new ProxyClient(
        createSecretStore() as never,
        createLogger(),
        5000,
        httpClient as never
      );

      await expect(
        client.createSession(createProfile({ allowSelfSigned: true }))
      ).resolves.toBe('abc-session');

      expect(agentSpy).toHaveBeenCalledWith(expect.objectContaining({ allowSelfSigned: true }));
      const requestConfig = httpClient.post.mock.calls[0]?.[2] as {
        httpsAgent?: unknown;
      };
      expect(requestConfig.httpsAgent).toBe(agentSpy.mock.results[0]?.value);
      agentSpy.mockRestore();
    });
  });

  describe('deleteSession', () => {
    it('completes without error', async () => {
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'deleteSession')
        .reply(200, { ok: true, data: {} });

      const client = createClient();
      await expect(client.deleteSession(createProfile())).resolves.toBeUndefined();
      scope.done();
    });
  });

  describe('listLayouts', () => {
    it('returns layout names from proxy response', async () => {
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'listLayouts')
        .reply(200, {
          ok: true,
          data: {
            layouts: [{ name: 'Contacts' }, { name: 'Invoices' }]
          }
        });

      const client = createClient();
      const layouts = await client.listLayouts(createProfile());

      expect(layouts).toEqual(['Contacts', 'Invoices']);
      scope.done();
    });
  });

  describe('getRecord', () => {
    it('returns the record from proxy response', async () => {
      const record = { recordId: '42', fieldData: { Name: 'Alice' } };
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'getRecord')
        .reply(200, { ok: true, data: { record } });

      const client = createClient();
      const result = await client.getRecord(createProfile(), 'Contacts', '42');

      expect(result.recordId).toBe('42');
      expect(result.fieldData).toEqual({ Name: 'Alice' });
      scope.done();
    });

    it('throws when proxy response has no record', async () => {
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'getRecord')
        .reply(200, { ok: true, data: {} });

      const client = createClient();
      await expect(client.getRecord(createProfile(), 'Contacts', '999')).rejects.toThrow(
        'Proxy response did not include a record object.'
      );
      scope.done();
    });
  });

  describe('findRecords', () => {
    it('returns find results from proxy response', async () => {
      const findResult = { data: [{ recordId: '1', fieldData: { Name: 'Bob' } }] };
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'findRecords')
        .reply(200, { ok: true, data: { result: findResult } });

      const client = createClient();
      const result = await client.findRecords(createProfile(), 'Contacts', {
        query: [{ Name: 'Bob' }]
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].fieldData).toEqual({ Name: 'Bob' });
      scope.done();
    });
  });

  describe('editRecord', () => {
    it('returns edit result from proxy response', async () => {
      const editResult = {
        recordId: '42',
        modId: '2',
        messages: [{ code: '0', message: 'OK' }],
        response: {}
      };
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'editRecord')
        .reply(200, { ok: true, data: { result: editResult } });

      const client = createClient();
      const result = await client.editRecord(createProfile(), 'Contacts', '42', {
        Name: 'Updated'
      });

      expect(result.recordId).toBe('42');
      expect(result.modId).toBe('2');
      scope.done();
    });

    it('throws when proxy response has no result', async () => {
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'editRecord')
        .reply(200, { ok: true, data: {} });

      const client = createClient();
      await expect(
        client.editRecord(createProfile(), 'Contacts', '42', { Name: 'X' })
      ).rejects.toThrow('Proxy response did not include an editRecord result payload.');
      scope.done();
    });
  });

  describe('runScript', () => {
    it('returns script result from proxy response', async () => {
      const scriptResult = {
        response: { scriptResult: 'done' },
        messages: [{ code: '0', message: 'OK' }]
      };
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'runScript')
        .reply(200, { ok: true, data: { result: scriptResult } });

      const client = createClient();
      const result = await client.runScript(createProfile(), {
        layout: 'Contacts',
        scriptName: 'MyScript'
      });

      expect(result.response).toEqual({ scriptResult: 'done' });
      scope.done();
    });
  });

  describe('missing proxy endpoint', () => {
    it('throws when proxy endpoint is missing', async () => {
      const client = createClient();
      await expect(client.createSession(createProfile({ proxyEndpoint: '' }))).rejects.toThrow(
        'Proxy mode requires a proxy endpoint'
      );
    });
  });

  describe('createRecord', () => {
    it('returns create result from proxy response', async () => {
      const createResult = {
        recordId: '99',
        modId: '1',
        messages: [{ code: '0', message: 'OK' }],
        response: {}
      };
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'createRecord')
        .reply(200, { ok: true, data: { result: createResult } });

      const client = createClient();
      const result = await client.createRecord(createProfile(), 'Contacts', { Name: 'New' });

      expect(result.recordId).toBe('99');
      scope.done();
    });
  });

  describe('deleteRecord', () => {
    it('returns delete result from proxy response', async () => {
      const deleteResult = {
        recordId: '42',
        messages: [{ code: '0', message: 'OK' }],
        response: {}
      };
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => body.action === 'deleteRecord')
        .reply(200, { ok: true, data: { result: deleteResult } });

      const client = createClient();
      const result = await client.deleteRecord(createProfile(), 'Contacts', '42');

      expect(result.recordId).toBe('42');
      scope.done();
    });
  });

  describe('uploadContainer', () => {
    it('sends base64 file content to the proxy action', async () => {
      const uploadResult = {
        recordId: '42',
        messages: [{ code: '0', message: 'OK' }],
        response: {}
      };
      const scope = nock(PROXY_URL)
        .post(PROXY_PATH, (body: Record<string, unknown>) => {
          const payload = body.payload as Record<string, unknown>;
          return (
            body.action === 'uploadContainer' &&
            payload.layout === 'Contacts' &&
            payload.recordId === '42' &&
            payload.fieldName === 'Attachment' &&
            payload.fieldRepetition === 1 &&
            payload.fileName === 'report.pdf' &&
            payload.contentType === 'application/pdf' &&
            payload.contentBase64 === Buffer.from('pdf-bytes').toString('base64')
          );
        })
        .reply(200, { ok: true, data: { result: uploadResult } });

      const client = createClient();
      const result = await client.uploadContainer(createProfile(), 'Contacts', '42', 'Attachment', {
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('pdf-bytes')
      });

      expect(result.recordId).toBe('42');
      scope.done();
    });
  });
});
