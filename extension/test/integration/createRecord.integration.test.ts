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
    id: 'create-profile',
    name: 'Create',
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
  await secretStore.setPassword('create-profile', 'password123');

  return new FMClient(secretStore, logger, 5_000);
}

describe('createRecord integration (mocked HTTP)', () => {
  it('creates record successfully and returns recordId', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'create-token-1' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .post(`${apiBase}/layouts/Contacts/records`, {
        fieldData: { FirstName: 'Ada', LastName: 'Lovelace' }
      })
      .reply(200, {
        response: { recordId: '42', modId: '1' },
        messages: [{ code: '0', message: 'OK' }]
      });

    const result = await client.createRecord(profile, 'Contacts', {
      FirstName: 'Ada',
      LastName: 'Lovelace'
    });

    expect(result.recordId).toBe('42');
    expect(result.modId).toBe('1');
    expect(result.messages.at(0)?.code).toBe('0');
  });

  it('retries on 401 with re-authentication', async () => {
    const profile = createProfile();
    const client = await createClient();

    // First session
    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'expired-token' }, messages: [{ code: '0', message: 'OK' }] });

    // First create attempt returns 401
    nock(server)
      .post(`${apiBase}/layouts/Contacts/records`)
      .reply(401, {
        messages: [{ code: '952', message: 'Invalid FileMaker Data API token' }]
      });

    // Re-auth
    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'fresh-token' }, messages: [{ code: '0', message: 'OK' }] });

    // Retry succeeds
    nock(server)
      .post(`${apiBase}/layouts/Contacts/records`)
      .reply(200, {
        response: { recordId: '99', modId: '1' },
        messages: [{ code: '0', message: 'OK' }]
      });

    const result = await client.createRecord(profile, 'Contacts', { Name: 'Test' });
    expect(result.recordId).toBe('99');
  });

  it('throws on server error', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'token-3' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .post(`${apiBase}/layouts/Contacts/records`)
      .reply(500, {
        messages: [{ code: '500', message: 'Record creation failed' }]
      });

    await expect(
      client.createRecord(profile, 'Contacts', { Name: 'Fail' })
    ).rejects.toThrow();
  });
});
