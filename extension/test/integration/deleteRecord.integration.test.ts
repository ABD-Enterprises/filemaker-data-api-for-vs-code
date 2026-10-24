import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';
const apiBase = '/fmi/data/vLatest/databases/TestDB';

function createProfile(): ConnectionProfile {
  return {
    id: 'delete-profile',
    name: 'Delete',
    authMode: 'direct',
    serverUrl: server,
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

async function createClient() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  await secretStore.setPassword('delete-profile', 'password123');

  return new FMClient(secretStore, logger, 5_000);
}

describe('deleteRecord integration (mocked HTTP)', () => {
  it('deletes record successfully', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'delete-token-1' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .delete(`${apiBase}/layouts/Contacts/records/42`)
      .reply(200, {
        response: {},
        messages: [{ code: '0', message: 'OK' }]
      });

    const result = await client.deleteRecord(profile, 'Contacts', '42');

    expect(result.recordId).toBe('42');
    expect(result.messages.at(0)?.code).toBe('0');
  });

  it('throws on 404 record not found', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'delete-token-2' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .delete(`${apiBase}/layouts/Contacts/records/999`)
      .reply(404, {
        messages: [{ code: '101', message: 'Record is missing' }]
      });

    await expect(
      client.deleteRecord(profile, 'Contacts', '999')
    ).rejects.toThrow();
  });

  it('retries on 401 with re-authentication', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'expired' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .delete(`${apiBase}/layouts/Contacts/records/42`)
      .reply(401, {
        messages: [{ code: '952', message: 'Invalid token' }]
      });

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'fresh' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .delete(`${apiBase}/layouts/Contacts/records/42`)
      .reply(200, {
        response: {},
        messages: [{ code: '0', message: 'OK' }]
      });

    const result = await client.deleteRecord(profile, 'Contacts', '42');
    expect(result.recordId).toBe('42');
  });
});
