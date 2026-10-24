import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { SchemaService } from '../../src/services/schemaService';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';
const apiBase = '/fmi/data/vLatest/databases/TestDB';

function createProfile(): ConnectionProfile {
  return {
    id: 'schema-profile',
    name: 'Schema',
    authMode: 'direct',
    serverUrl: server,
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

async function createClientAndSchema() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  await secretStore.setPassword('schema-profile', 'password123');

  const client = new FMClient(secretStore, logger, 5_000);
  const schemaService = new SchemaService(client, logger, {
    isMetadataEnabled: () => true,
    getCacheTtlMs: () => 300_000
  });

  return { client, schemaService };
}

describe('Schema metadata integration (mocked HTTP)', () => {
  it('loads field metadata successfully', async () => {
    const profile = createProfile();
    const { schemaService } = await createClientAndSchema();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'schema-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts/Contacts`)
      .reply(200, {
        response: {
          fieldMetaData: [
            { name: 'FirstName', type: 'text' },
            { name: 'LastName', type: 'text' }
          ]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    const result = await schemaService.getFields(profile, 'Contacts');

    expect(result.supported).toBe(true);
    expect(result.fields.map((item) => item.name)).toEqual(['FirstName', 'LastName']);
  });

  it('handles unsupported metadata endpoints gracefully', async () => {
    const profile = createProfile();
    const { schemaService } = await createClientAndSchema();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'schema-token-2' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts/Contacts`)
      .reply(501, {
        messages: [{ code: '501', message: 'Not Implemented' }]
      });

    const result = await schemaService.getFields(profile, 'Contacts');

    expect(result.supported).toBe(false);
    expect(result.message).toContain('not supported');
  });
});
