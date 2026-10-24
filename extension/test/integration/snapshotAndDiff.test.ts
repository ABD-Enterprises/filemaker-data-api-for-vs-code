import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { diffSchemaFields } from '../../src/services/schemaDiff';
import { FMClient } from '../../src/services/fmClient';
import { SchemaService } from '../../src/services/schemaService';
import { SchemaSnapshotStore } from '../../src/services/schemaSnapshotStore';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemoryMemento, InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';
const apiBase = '/fmi/data/vLatest/databases/TestDB';

function createProfile(): ConnectionProfile {
  return {
    id: 'snapshot-profile',
    name: 'Snapshot',
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
  await secretStore.setPassword('snapshot-profile', 'password123');

  const client = new FMClient(secretStore, logger, 5_000);
  const schemaService = new SchemaService(client, logger, {
    isMetadataEnabled: () => true,
    getCacheTtlMs: () => 1
  });

  return { client, schemaService, logger };
}

describe('snapshot + diff integration (mocked HTTP)', () => {
  it('captures snapshot and diffs against current metadata', async () => {
    const profile = createProfile();
    const { schemaService, logger } = await createClientAndSchema();
    const store = new SchemaSnapshotStore(new InMemoryMemento() as never, logger as never, {
      getStorageMode: () => 'workspaceState',
      isWorkspaceTrusted: () => true
    });

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'snap-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts/Contacts`)
      .reply(200, {
        response: {
          fieldMetaData: [{ name: 'FirstName', type: 'text' }]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    const baseline = await schemaService.getLayoutSchema(profile, 'Contacts');
    const snapshot = await store.captureSnapshot({
      profileId: profile.id,
      layout: 'Contacts',
      source: 'manual',
      metadata: baseline.metadata ?? {}
    });

    schemaService.invalidateAll();

    nock(server)
      .get(`${apiBase}/layouts/Contacts`)
      .reply(200, {
        response: {
          fieldMetaData: [
            { name: 'FirstName', type: 'number' },
            { name: 'LastName', type: 'text' }
          ]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    const current = await schemaService.getLayoutSchema(profile, 'Contacts');

    const diff = diffSchemaFields({
      profileId: profile.id,
      layout: 'Contacts',
      olderSnapshotId: snapshot.id,
      beforeFields: baseline.fields,
      afterFields: current.fields
    });

    expect(diff.summary.added).toBe(1);
    expect(diff.summary.changed).toBe(1);
    expect(diff.hasChanges).toBe(true);
  });
});
