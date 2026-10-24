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
    id: 'edit-profile',
    name: 'Edit',
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
  await secretStore.setPassword('edit-profile', 'password123');

  return new FMClient(secretStore, logger, 5_000);
}

describe('editRecord integration (mocked HTTP)', () => {
  it('edits record successfully', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'edit-token-1' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .patch(`${apiBase}/layouts/Contacts/records/10`, {
        fieldData: { FirstName: 'Ada' }
      })
      .reply(200, {
        response: { modId: '2' },
        messages: [{ code: '0', message: 'OK' }]
      });

    const result = await client.editRecord(profile, 'Contacts', '10', { FirstName: 'Ada' });

    expect(result.recordId).toBe('10');
    expect(result.modId).toBe('2');
    expect(result.messages.at(0)?.code).toBe('0');
  });

  it('maps edit failures to normalized FM error messages', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'edit-token-2' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .patch(`${apiBase}/layouts/Contacts/records/10`)
      .reply(500, {
        messages: [{ code: '500', message: 'Write failed' }]
      });

    await expect(client.editRecord(profile, 'Contacts', '10', { FirstName: 'Ada' })).rejects.toThrow(
      'Write failed'
    );
  });
});
