import type { AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { NetworkLogStore } from '../../src/diagnostics/networkLogStore';
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

  it('captures redacted direct Data API network requests when enabled', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    const networkLogStore = new NetworkLogStore({
      now: () => new Date('2026-05-24T12:00:00.000Z')
    });

    await secretStore.setPassword(profile.id, 'pass');

    axios.request
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          'x-session-id': 'server-session-header'
        },
        data: {
          response: {
            token: 'token-a'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>)
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          'x-request-id': 'req-server-1'
        },
        data: {
          response: {
            layouts: [{ name: 'Contacts' }]
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      } as AxiosResponse<Record<string, unknown>>);

    const client = new FMClient(
      secretStore,
      logger,
      15_000,
      axios as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recorder: networkLogStore,
        isEnabled: () => true
      }
    );

    await client.listLayouts(profile);

    const entries = networkLogStore.listEntries();
    expect(entries).toHaveLength(2);

    const listEntry = entries.find((entry) => entry.relativeUrl.endsWith('/layouts'));
    expect(listEntry?.method).toBe('GET');
    expect(listEntry?.responseStatus).toBe(200);
    expect(listEntry?.requestHeaders.Authorization).toBe('***');
    expect(listEntry?.responseHeaders['x-request-id']).toBe('req-server-1');

    const sessionEntry = entries.find((entry) => entry.relativeUrl.endsWith('/sessions'));
    expect(sessionEntry?.method).toBe('POST');
    expect(sessionEntry?.requestHeaders.Authorization).toBe('***');
    expect(sessionEntry?.responseBody).toMatchObject({
      response: {
        token: '***'
      }
    });
  });

  it('does not capture direct Data API network requests when disabled', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    const networkLogStore = new NetworkLogStore();

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

    const client = new FMClient(
      secretStore,
      logger,
      15_000,
      axios as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recorder: networkLogStore,
        isEnabled: () => false
      }
    );

    await client.listLayouts(profile);

    expect(networkLogStore.listEntries()).toHaveLength(0);
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
});
