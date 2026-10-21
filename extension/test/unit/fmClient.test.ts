import { describe, expect, it, vi } from 'vitest';

import { selectErrorActions } from '../../src/utils/errorUx';
import { normalizeError } from '../../src/utils/normalizeError';
import { isRetryableConnectError } from '../../src/commands';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { createAxiosResponse, InMemorySecretStorage } from './mocks';

class FakeAxios {
  public readonly request = vi.fn();
}

function createProfile(): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Dev',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

describe('FMClient (unit)', () => {
  it.each((['direct', 'proxy'] as const).flatMap((authMode) => [
    { operation: 'createSession', uncertain: false, call: (client: FMClient, profile: ConnectionProfile) => client.createSession(profile) },
    { operation: 'deleteSession', uncertain: false, call: (client: FMClient, profile: ConnectionProfile) => client.deleteSession(profile) },
    { operation: 'findRecords', uncertain: false, call: (client: FMClient, profile: ConnectionProfile) => client.findRecords(profile, 'Contacts', { query: [{}] }) },
    { operation: 'getLayoutMetadata', uncertain: false, call: (client: FMClient, profile: ConnectionProfile) => client.getLayoutMetadata(profile, 'Contacts') },
    { operation: 'createRecord', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.createRecord(profile, 'Contacts', {}) },
    { operation: 'editRecord', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.editRecord(profile, 'Contacts', '1', { Name: 'Changed' }) },
    { operation: 'deleteRecord', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.deleteRecord(profile, 'Contacts', '1') },
    { operation: 'uploadContainer', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.uploadContainer(profile, 'Contacts', '1', 'Photo', { fileName: 'photo.png', content: Buffer.from('photo'), contentType: 'image/png' }) },
    { operation: 'runScript', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.runScript(profile, { layout: 'Contacts', scriptName: 'Slow' }) },
    ...(['script', 'script.prerequest', 'script.presort'] as const).map((key) => ({
      operation: `findRecords with ${key}`, uncertain: true,
      call: (client: FMClient, profile: ConnectionProfile) => client.findRecords(profile, 'Contacts', { query: [{}], [key]: 'Slow' })
    }))
  ].map((test) => ({ authMode, ...test }))))('classifies $authMode $operation timeout by the logical request', async ({ authMode, operation, uncertain, call }) => {
    // Some adapters omit axios config on errors; the recorded request must suffice.
    const timeout = { isAxiosError: true, code: 'ECONNABORTED', message: 'timeout' };
    const axios = { request: vi.fn().mockRejectedValue(timeout), post: vi.fn().mockRejectedValue(timeout) };
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = { ...createProfile(), authMode, proxyEndpoint: 'https://proxy.example/api' };
    await secrets.setPassword(profile.id, 'password');
    await secrets.setSessionToken(profile.id, 'token');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new FMClient(secrets, logger, 1500, axios as never);
    const result = await call(client, profile).then(() => undefined, (error: unknown) => error);
    const error = operation === 'deleteSession'
      ? logger.warn.mock.calls.find(([message]) => message === 'Failed to delete session cleanly during disconnect.')?.[1]?.error
      : result;
    expect(error).toMatchObject({ kind: 'timeout', isRetryable: !uncertain });
    expect((error as Error).message.includes('The change may have been applied. Check the record before trying again.')).toBe(uncertain);
    expect((error as Error).message).toContain('filemaker.requestTimeoutMs');
    if (operation === 'createSession') expect(isRetryableConnectError(error)).toBe(true);
    expect(selectErrorActions(normalizeError(error), { retry: vi.fn() }).includes('Retry')).toBe(!uncertain);
    if (operation.startsWith('findRecords with ') && authMode === 'direct') {
      const key = operation.slice('findRecords with '.length);
      expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ [key]: 'Slow' }) }));
    }
  });

  it.each((['direct', 'proxy'] as const).flatMap((authMode) =>
    (['editRecord', 'createRecord'] as const).flatMap((operation) =>
      ['A\0B', 'A\0B\0C', ['A\0B\0C'], { nested: 'A\0B\0C' }].map((value) => ({ authMode, operation, value }))
    )
  ))('refuses NUL before any $authMode $operation request: $value', async ({ authMode, operation, value }) => {
    const axios = new FakeAxios();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const proxy = { editRecord: vi.fn(), createRecord: vi.fn() };
    const client = new FMClient(secrets, logger, 15_000, axios as never, proxy as never);
    const profile = { ...createProfile(), authMode };
    const fields = { Name: value };
    const pending = operation === 'editRecord'
      ? client.editRecord(profile, 'Contacts', '1', fields)
      : client.createRecord(profile, 'Contacts', fields);
    await expect(pending).rejects.toMatchObject({ status: 400, isRetryable: false, message: expect.stringContaining('NUL character (U+0000) in field(s): Name.') });
    expect(axios.request).not.toHaveBeenCalled();
    expect(proxy.editRecord).not.toHaveBeenCalled();
    expect(proxy.createRecord).not.toHaveBeenCalled();
  });

  it.each([false, true])('omits ancillary metadata history (failure=%s) while retaining record history, metrics and normal metadata history', async (failMetadata) => {
    const axios = new FakeAxios();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    await secrets.setSessionToken(profile.id, 'token');
    const response = (data: unknown) => createAxiosResponse({ data: { response: data, messages: [{ code: '0', message: 'OK' }] } });
    axios.request.mockResolvedValue(response({ fieldMetaData: [] }));
    const history = { record: vi.fn(async () => undefined) };
    const metrics = { record: vi.fn(async () => undefined) };
    const client = new FMClient(secrets, logger, 15_000, axios as never, undefined, history, metrics);
    if (failMetadata) axios.request.mockRejectedValueOnce(new Error('metadata failed'));
    const lookup = client.getLayoutMetadata(profile, ' Exact layout ', { recordHistory: false });
    if (failMetadata) await expect(lookup).rejects.toThrow('metadata failed');
    else await lookup;
    expect(history.record).not.toHaveBeenCalled();
    expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({ operation: 'getLayoutMetadata', success: !failMetadata }));
    axios.request.mockResolvedValueOnce(response({ data: [{ recordId: '1', fieldData: { Value: ' exact ' } }] }));
    await client.getRecord(profile, ' Exact layout ', '1');
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'getRecord', layout: ' Exact layout ' }));
    await client.getLayoutMetadata(profile, ' Exact layout ');
    expect(history.record).toHaveBeenCalledTimes(2);
    expect(history.record).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'getLayoutMetadata' }));
  });

  it('constructs authenticated request headers for Data API calls', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();

    await secretStore.setPassword(profile.id, 'pass');

    axios.request
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            token: 'token-a'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }))
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            layouts: [{ name: 'Contacts' }]
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }));

    const client = new FMClient(secretStore, logger, 15_000, axios as never);
    await client.listLayouts(profile);

    expect(axios.request).toHaveBeenCalledTimes(2);
    const listRequest = axios.request.mock.calls[1]?.[0] as Record<string, unknown>;
    const headers = listRequest.headers as Record<string, string>;
    expect(String(listRequest.url)).toContain('/fmi/data/vLatest/databases/TestDB/layouts');
    expect(headers.Authorization).toBe('Bearer token-a');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('maps FileMaker error payloads to helpful errors', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();

    await secretStore.setPassword(profile.id, 'pass');

    axios.request
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            token: 'token-a'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }))
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: 'Request failed with status code 500',
        response: {
          status: 500,
          data: {
            messages: [{ code: '500', message: 'Internal server error' }]
          }
        }
      });

    const client = new FMClient(secretStore, logger, 15_000, axios as never);

    await expect(client.listLayouts(profile)).rejects.toThrow(
      'FileMaker API error (HTTP 500) [500]'
    );
  });

  it('re-authenticates once on 401 and retries request', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();

    await secretStore.setPassword(profile.id, 'pass');

    axios.request
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            token: 'old-token'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }))
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: 'Unauthorized',
        response: {
          status: 401,
          data: {
            messages: [{ code: '952', message: 'Invalid token' }]
          }
        }
      })
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            token: 'new-token'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }))
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            layouts: [{ name: 'Contacts' }]
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }));

    const client = new FMClient(secretStore, logger, 15_000, axios as never);

    await expect(client.listLayouts(profile)).resolves.toEqual(['Contacts']);
    await expect(secretStore.getSessionToken(profile.id)).resolves.toBe('new-token');
    expect(axios.request).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['image upload', 'photo.png', 'image/png'],
    ['PDF upload', 'report.pdf', 'application/pdf'],
    ['binary upload', 'archive.bin', 'application/octet-stream']
  ])(
    'uploads container data as multipart form-data for %s',
    async (_label, fileName, contentType) => {
      const axios = new FakeAxios();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      };
      const secretStore = new SecretStore(new InMemorySecretStorage() as never);
      const profile = createProfile();

      await secretStore.setSessionToken(profile.id, 'token-a');

      axios.request.mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {},
          messages: [{ code: '0', message: 'OK' }]
        }
      }));

      const client = new FMClient(secretStore, logger, 15_000, axios as never);
      const result = await client.uploadContainer(
        profile,
        'Contacts',
        '42',
        'Attachment',
        {
          fileName,
          content: Buffer.from(`content:${fileName}`, 'utf8'),
          contentType
        },
        {
          maxBytes: 1024
        }
      );

      expect(result.recordId).toBe('42');
      expect(axios.request).toHaveBeenCalledTimes(1);

      const uploadRequest = axios.request.mock.calls[0]?.[0] as Record<string, unknown>;
      const headers = uploadRequest.headers as Record<string, string>;
      const body = uploadRequest.data as Buffer;

      expect(String(uploadRequest.url)).toContain(
        '/fmi/data/vLatest/databases/TestDB/layouts/Contacts/records/42/containers/Attachment/1'
      );
      expect(headers.Authorization).toBe('Bearer token-a');
      expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
      expect(headers['Content-Length']).toBe(String(body.byteLength));
      expect(body.toString('utf8')).toContain('name="upload"');
      expect(body.toString('utf8')).toContain(`filename="${fileName}"`);
      expect(body.toString('utf8')).toContain(`Content-Type: ${contentType}`);
      expect(body.toString('utf8')).toContain(`content:${fileName}`);
    }
  );

  it('rejects container uploads larger than the configured limit before sending a request', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    const client = new FMClient(secretStore, logger, 15_000, axios as never);

    await expect(
      client.uploadContainer(
        profile,
        'Contacts',
        '42',
        'Attachment',
        {
          fileName: 'too-large.bin',
          content: Buffer.alloc(11),
          contentType: 'application/octet-stream'
        },
        {
          maxBytes: 10
        }
      )
    ).rejects.toThrow('Container upload exceeds the configured limit');

    expect(axios.request).not.toHaveBeenCalled();
  });
});

it.each([200, 404, 500])('preserves foundCount for an empty page with FileMaker 401 on HTTP %s', async (status) => {
  const axios = new FakeAxios();
  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  const profile = createProfile();
  await secrets.setSessionToken(profile.id, 'token');
  const data = { response: { data: [], dataInfo: { foundCount: 157, returnedCount: 0, totalRecordCount: 200 } }, messages: [{ code: '401', message: 'No records match' }] };
  if (status === 200) axios.request.mockResolvedValueOnce(createAxiosResponse({ data }));
  else axios.request.mockRejectedValueOnce({ isAxiosError: true, response: { status, data } });
  const client = new FMClient(secrets, { debug() {}, info() {}, warn() {}, error() {} }, 15_000, axios as never);
  const result = await client.findRecords(profile, 'Contacts', { query: [{}], offset: 158 });
  expect(result).toEqual({ data: [], dataInfo: { foundCount: 157, returnedCount: 0, totalRecordCount: 200 } });
});

describe('getRecord portal totals', () => {
  it.each(['record', 'dataInfo'] as const)('preserves portalDataInfo supplied on %s', async (where) => {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    await secrets.setSessionToken(profile.id, 'token');
    const info = [{ portalObjectName: ' Lines ', foundCount: 60, returnedCount: 20 }];
    const record = { recordId: '1', fieldData: {}, portalData: { ' Lines ': [] }, ...(where === 'record' ? { portalDataInfo: info } : {}) };
    const axios = new FakeAxios();
    axios.request.mockResolvedValue(createAxiosResponse({ data: { response: { data: [record], ...(where === 'dataInfo' ? { dataInfo: { portalDataInfo: info } } : {}) }, messages: [{ code: '0', message: 'OK' }] } }));
    const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 1500, axios as never);
    expect(await client.getRecord(profile, ' Contacts ', '1')).toMatchObject({ portalDataInfo: info });
  });
});
