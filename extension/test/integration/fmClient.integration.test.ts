import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { FMClientError, isRecordModifiedConflict } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';
const apiBase = '/fmi/data/vLatest/databases/TestDB';

function createProfile(): ConnectionProfile {
  return {
    id: 'integration-profile',
    name: 'Integration',
    authMode: 'direct',
    serverUrl: server,
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

async function createClient(timeoutMs = 5_000) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  await secretStore.setPassword('integration-profile', 'password123');
  const client = new FMClient(secretStore, logger, timeoutMs);

  return {
    client,
    secretStore,
    logger
  };
}

describe('FMClient integration (mocked HTTP)', () => {

  describe('edit with a modification id', () => {
    const conflict = { messages: [{ code: '306', message: 'Record modification ID does not match' }], response: {} };

    it('sends modId with the edit when one is given', async () => {
      const profile = createProfile();
      const { client } = await createClient();
      let sent: Record<string, unknown> | undefined;

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'token-edit' }, messages: [{ code: '0', message: 'OK' }] });
      nock(server)
        .patch(`${apiBase}/layouts/Contacts/records/7`, (body: Record<string, unknown>) => {
          sent = body;
          return true;
        })
        .reply(200, { response: { modId: '4' }, messages: [{ code: '0', message: 'OK' }] });

      const result = await client.editRecord(profile, 'Contacts', '7', { Status: 'Closed' }, undefined, {
        modId: '3'
      });

      expect(sent).toEqual({ fieldData: { Status: 'Closed' }, modId: '3' });
      expect(result.modId).toBe('4');
    });

    it('sends no modId when none is given, as before', async () => {
      const profile = createProfile();
      const { client } = await createClient();
      let sent: Record<string, unknown> | undefined;

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'token-edit2' }, messages: [{ code: '0', message: 'OK' }] });
      nock(server)
        .patch(`${apiBase}/layouts/Contacts/records/7`, (body: Record<string, unknown>) => {
          sent = body;
          return true;
        })
        .reply(200, { response: { modId: '4' }, messages: [{ code: '0', message: 'OK' }] });

      await client.editRecord(profile, 'Contacts', '7', { Status: 'Closed' });

      expect(sent).toEqual({ fieldData: { Status: 'Closed' } });
    });

    it('reports FileMaker error 306 as a conflict the caller can recognise', async () => {
      const profile = createProfile();
      const { client } = await createClient();

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'token-306' }, messages: [{ code: '0', message: 'OK' }] });
      nock(server).patch(`${apiBase}/layouts/Contacts/records/7`).reply(500, conflict);

      const error = await client
        .editRecord(profile, 'Contacts', '7', { Status: 'Open' }, undefined, { modId: '1' })
        .catch((caught: unknown) => caught);

      expect(isRecordModifiedConflict(error)).toBe(true);
      expect(isRecordModifiedConflict(new Error('306'))).toBe(false);
      expect(isRecordModifiedConflict(new FMClientError('other', { code: '101' }))).toBe(false);
    });
  });

  describe('find with no matches', () => {
    const noMatch = {
      messages: [{ code: '401', message: 'No records match the request' }],
      response: {}
    };

    it('returns an empty result when FileMaker reports error 401', async () => {
      const profile = createProfile();
      const { client } = await createClient();

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'token-none' }, messages: [{ code: '0', message: 'OK' }] });
      nock(server)
        .post(`${apiBase}/layouts/Contacts/_find`)
        .matchHeader('authorization', 'Bearer token-none')
        .reply(404, noMatch);

      await expect(
        client.findRecords(profile, 'Contacts', { query: [{ Email: 'nobody@example.com' }] })
      ).resolves.toEqual({ data: [], dataInfo: { foundCount: 0, returnedCount: 0 } });
    });

    it('treats an offset past the last match the same way', async () => {
      const profile = createProfile();
      const { client } = await createClient();

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'token-past' }, messages: [{ code: '0', message: 'OK' }] });
      nock(server)
        .post(`${apiBase}/layouts/Contacts/_find`, (body: { offset?: number }) => body.offset === 101)
        .reply(404, noMatch);

      const result = await client.findRecords(profile, 'Contacts', {
        query: [{ Status: 'Open' }],
        limit: 100,
        offset: 101
      });
      expect(result.data).toEqual([]);
    });

    it('still reports other 404 errors, such as a missing layout', async () => {
      const profile = createProfile();
      const { client } = await createClient();

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'token-404' }, messages: [{ code: '0', message: 'OK' }] });
      nock(server)
        .post(`${apiBase}/layouts/Nope/_find`)
        .reply(404, { messages: [{ code: '105', message: 'Layout is missing' }], response: {} });

      await expect(client.findRecords(profile, 'Nope', { query: [{}] })).rejects.toThrow(/105|Layout is missing/);
    });
  });

  describe('expired session with parallel requests', () => {
    const rejected = { messages: [{ code: '952', message: 'Invalid FileMaker Data API token (*)' }] };
    const okFind = { response: { data: [], dataInfo: {} }, messages: [{ code: '0', message: 'OK' }] };

    it('renews the session once for requests that all hit the expired token', async () => {
      const profile = createProfile();
      const { client } = await createClient();
      const sessions = vi.fn();

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'old' }, messages: [{ code: '0', message: 'OK' }] });
      await client.createSession(profile);

      nock(server)
        .post(`${apiBase}/sessions`)
        .times(5)
        .reply(() => {
          sessions();
          return [200, { response: { token: 'fresh' }, messages: [{ code: '0', message: 'OK' }] }];
        });
      nock(server).post(`${apiBase}/layouts/Contacts/_find`).matchHeader('authorization', 'Bearer old').times(5).reply(401, rejected);
      nock(server).post(`${apiBase}/layouts/Contacts/_find`).matchHeader('authorization', 'Bearer fresh').times(5).reply(200, okFind);

      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((limit) => client.findRecords(profile, 'Contacts', { query: [{}], limit }))
      );

      expect(results).toHaveLength(5);
      expect(sessions).toHaveBeenCalledTimes(1);
    });

    it('lets a request whose rejection arrives after the renewal reuse the new token', async () => {
      const profile = createProfile();
      const { client } = await createClient();
      const sessions = vi.fn();

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'old' }, messages: [{ code: '0', message: 'OK' }] });
      await client.createSession(profile);

      nock(server)
        .post(`${apiBase}/sessions`)
        .times(2)
        .reply(() => {
          sessions();
          return [200, { response: { token: 'fresh' }, messages: [{ code: '0', message: 'OK' }] }];
        });
      const find = nock(server).post(`${apiBase}/layouts/Contacts/_find`);
      find.matchHeader('authorization', 'Bearer old').reply(401, rejected);
      nock(server)
        .post(`${apiBase}/layouts/Contacts/_find`)
        .matchHeader('authorization', 'Bearer old')
        .delay(150)
        .reply(401, rejected);
      nock(server).post(`${apiBase}/layouts/Contacts/_find`).matchHeader('authorization', 'Bearer fresh').times(2).reply(200, okFind);

      await Promise.all([
        client.findRecords(profile, 'Contacts', { query: [{}], limit: 1 }),
        client.findRecords(profile, 'Contacts', { query: [{}], limit: 2 })
      ]);

      expect(sessions).toHaveBeenCalledTimes(1);
    });

    it('surfaces a failed renewal to every waiting request', async () => {
      const profile = createProfile();
      const { client } = await createClient();

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(200, { response: { token: 'old' }, messages: [{ code: '0', message: 'OK' }] });
      await client.createSession(profile);

      nock(server)
        .post(`${apiBase}/sessions`)
        .reply(401, { messages: [{ code: '212', message: 'Invalid user account and/or password' }] });
      nock(server).post(`${apiBase}/layouts/Contacts/_find`).matchHeader('authorization', 'Bearer old').times(3).reply(401, rejected);

      const settled = await Promise.allSettled(
        [1, 2, 3].map((limit) => client.findRecords(profile, 'Contacts', { query: [{}], limit }))
      );

      expect(settled.every((entry) => entry.status === 'rejected')).toBe(true);
    });
  });
  it('lists layouts successfully', async () => {
    const profile = createProfile();
    const { client, logger } = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-1' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts`)
      .matchHeader('authorization', 'Bearer token-1')
      .reply(200, {
        response: {
          layouts: [{ name: 'Contacts' }, { name: 'Invoices' }]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    await expect(client.listLayouts(profile)).resolves.toEqual(['Contacts', 'Invoices']);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('flattens folder layout structures from list layouts response', async () => {
    const profile = createProfile();
    const { client } = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-folder' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts`)
      .matchHeader('authorization', 'Bearer token-folder')
      .reply(200, {
        response: {
          layouts: [
            {
              name: 'Assets',
              folderLayoutNames: [{ name: 'Assets_List' }, { name: 'Assets_Detail' }]
            }
          ]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    await expect(client.listLayouts(profile)).resolves.toEqual(['Assets_List', 'Assets_Detail']);
  });

  it('gets a record successfully', async () => {
    const profile = createProfile();
    const { client } = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-2' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts/Contacts/records/1`)
      .reply(200, {
        response: {
          data: [
            {
              recordId: '1',
              modId: '0',
              fieldData: { FirstName: 'Ada', LastName: 'Lovelace' }
            }
          ]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    await expect(client.getRecord(profile, 'Contacts', '1')).resolves.toMatchObject({
      recordId: '1',
      fieldData: { FirstName: 'Ada' }
    });
  });

  it('finds records successfully', async () => {
    const profile = createProfile();
    const { client } = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-3' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .post(`${apiBase}/layouts/Contacts/_find`)
      .reply(200, {
        response: {
          data: [
            {
              recordId: '10',
              fieldData: { FirstName: 'Grace', LastName: 'Hopper' }
            }
          ],
          dataInfo: {
            foundCount: 1
          }
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    await expect(
      client.findRecords(profile, 'Contacts', {
        query: [{ FirstName: 'Grace' }],
        limit: 1,
        offset: 0
      })
    ).resolves.toMatchObject({
      data: [
        {
          recordId: '10'
        }
      ]
    });
  });

  it('re-authenticates on 401 and retries once', async () => {
    const profile = createProfile();
    const { client } = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-old' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts`)
      .matchHeader('authorization', 'Bearer token-old')
      .reply(401, {
        messages: [{ code: '952', message: 'Invalid token' }]
      });

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-new' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts`)
      .matchHeader('authorization', 'Bearer token-new')
      .reply(200, {
        response: {
          layouts: [{ name: 'Contacts' }]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    await expect(client.listLayouts(profile)).resolves.toEqual(['Contacts']);
  });

  it('surfaces FileMaker error payload details', async () => {
    const profile = createProfile();
    const { client } = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-5' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts`)
      .reply(500, {
        messages: [{ code: '500', message: 'Server processing error' }]
      });

    await expect(client.listLayouts(profile)).rejects.toThrow('Server processing error');
  });

  it('handles non-JSON server responses without crashing', async () => {
    const profile = createProfile();
    const { client } = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-6' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts`)
      .reply(500, 'Internal Server Error');

    await expect(client.listLayouts(profile)).rejects.toThrow('HTTP 500');
  });

  it('maps slow responses to timeout errors', async () => {
    const profile = createProfile();
    const { client } = await createClient(50);

    nock(server)
      .post(`${apiBase}/sessions`)
      .delay(100)
      .reply(200, { response: { token: 'token-7' }, messages: [{ code: '0', message: 'OK' }] });

    await expect(client.listLayouts(profile)).rejects.toThrow(/timed out|timeout/i);
  });

  it('maps aborted requests to cancellation errors', async () => {
    const profile = createProfile();
    const { client } = await createClient(5_000);
    const controller = new AbortController();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-8' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts`)
      .delay(200)
      .reply(200, {
        response: { layouts: [{ name: 'Contacts' }] },
        messages: [{ code: '0', message: 'OK' }]
      });

    setTimeout(() => controller.abort(), 10);

    await expect(client.listLayouts(profile, { signal: controller.signal })).rejects.toThrow(
      /cancelled|canceled|abort/i
    );
  });
});
