import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { EnvironmentCompareService } from '../../src/enterprise/environmentCompareService';
import { FMClient } from '../../src/services/fmClient';
import { SchemaService } from '../../src/services/schemaService';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile, EnvironmentSet } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';

function createProfiles(): ConnectionProfile[] {
  return [
    {
      id: 'dev',
      name: 'Dev',
      authMode: 'direct',
      serverUrl: server,
      database: 'DevDB',
      username: 'admin',
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    },
    {
      id: 'prod',
      name: 'Prod',
      authMode: 'direct',
      serverUrl: server,
      database: 'ProdDB',
      username: 'admin',
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    }
  ];
}

function createSet(): EnvironmentSet {
  return {
    id: 'env-set',
    name: 'Dev vs Prod',
    profiles: ['dev', 'prod'],
    createdAt: new Date().toISOString()
  };
}

async function createClient(profiles: ConnectionProfile[]): Promise<FMClient> {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  for (const profile of profiles) {
    await secretStore.setPassword(profile.id, 'password123');
  }

  return new FMClient(secretStore, logger, 5_000);
}

describe('environment compare integration (mocked HTTP)', () => {
  it('compares two environments and returns field-level diff', async () => {
    const profiles = createProfiles();
    const client = await createClient(profiles);
    const schemaService = new SchemaService(client, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    });
    const compareService = new EnvironmentCompareService(client, schemaService, {
      debug: vi.fn(),
      warn: vi.fn()
    });

    nock(server)
      .post('/fmi/data/vLatest/databases/DevDB/sessions')
      .reply(200, { response: { token: 'dev-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .post('/fmi/data/vLatest/databases/ProdDB/sessions')
      .reply(200, { response: { token: 'prod-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get('/fmi/data/vLatest/databases/DevDB/layouts')
      .reply(200, {
        response: { layouts: [{ name: 'Contacts' }, { name: 'Invoices' }] },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .get('/fmi/data/vLatest/databases/ProdDB/layouts')
      .reply(200, {
        response: { layouts: [{ name: 'Contacts' }] },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .get('/fmi/data/vLatest/databases/DevDB/layouts/Contacts')
      .reply(200, {
        response: {
          fieldMetaData: [{ name: 'Name', type: 'text' }],
          scripts: [{ name: 'SyncContacts' }]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .get('/fmi/data/vLatest/databases/ProdDB/layouts/Contacts')
      .reply(200, {
        response: {
          fieldMetaData: [
            { name: 'Name', type: 'number' },
            { name: 'ExternalId', type: 'text' }
          ],
          scripts: [{ name: 'SyncContacts' }, { name: 'FixLegacy' }]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .get('/fmi/data/vLatest/databases/DevDB/layouts/Invoices')
      .reply(200, {
        response: {
          fieldMetaData: [{ name: 'InvoiceId', type: 'text' }]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    const compare = await compareService.compareEnvironmentSet(createSet(), profiles);
    expect(compare.summary.totalLayouts).toBe(2);
    expect(compare.summary.differentLayouts).toBeGreaterThan(0);

    const diff = await compareService.diffLayoutAcrossEnvironments(createSet(), 'Contacts', profiles);
    const prod = diff.profileResults.find((item) => item.profileId === 'prod');
    expect(prod?.addedFields).toContain('ExternalId');
    expect(prod?.changedFields.some((item) => item.fieldName === 'Name')).toBe(true);
  });
});
