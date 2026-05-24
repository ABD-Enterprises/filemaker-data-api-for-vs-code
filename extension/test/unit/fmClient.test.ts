import type { AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from './mocks';

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
      .mockResolvedValueOnce({
        data: {
          response: {
            token: 'token-a'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>)
      .mockResolvedValueOnce({
        data: {
          response: {
            layouts: [{ name: 'Contacts' }]
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>);

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
      .mockResolvedValueOnce({
        data: {
          response: {
            token: 'token-a'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>)
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
      .mockResolvedValueOnce({
        data: {
          response: {
            token: 'old-token'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>)
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
      .mockResolvedValueOnce({
        data: {
          response: {
            token: 'new-token'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>)
      .mockResolvedValueOnce({
        data: {
          response: {
            layouts: [{ name: 'Contacts' }]
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>);

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

      axios.request.mockResolvedValueOnce({
        data: {
          response: {},
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>);

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
