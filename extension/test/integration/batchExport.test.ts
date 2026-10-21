import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { BatchService } from '../../src/services/batchService';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';
const apiBase = '/fmi/data/vLatest/databases/TestDB';

function createProfile(): ConnectionProfile {
  return {
    id: 'batch-profile',
    name: 'Batch',
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
  await secretStore.setPassword('batch-profile', 'password123');

  return new FMClient(secretStore, logger, 5_000);
}

describe('batch export + update integration (mocked HTTP)', () => {
  it('exports paginated find results to JSONL', async () => {
    const profile = createProfile();
    const client = await createClient();
    const batchService = new BatchService(client);
    const root = await mkdtemp(join(tmpdir(), 'fm-batch-'));
    const outputPath = join(root, 'contacts.jsonl');

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'batch-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .post(`${apiBase}/layouts/Contacts/_find`, (body) => body.offset === 1 && body.limit === 2)
      .reply(200, {
        response: {
          data: [
            { recordId: '1', fieldData: { FirstName: 'Ada' } },
            { recordId: '2', fieldData: { FirstName: 'Grace' } }
          ]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .post(`${apiBase}/layouts/Contacts/_find`, (body) => body.offset === 3 && body.limit === 2)
      .reply(200, {
        response: {
          data: [{ recordId: '3', fieldData: { FirstName: 'Linus' } }]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    const result = await batchService.batchExportFind(
      profile,
      'Contacts',
      {
        query: [{ Name: '*' }]
      },
      {
        outputPath,
        format: 'jsonl',
        maxRecords: 10,
        pageSize: 2
      }
    );

    expect(result.exportedRecords).toBe(3);
    const content = await readFile(outputPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('handles dry-run and execute batch updates', async () => {
    const profile = createProfile();
    const client = await createClient();
    const batchService = new BatchService(client);

    const entries = [
      { recordId: '10', fieldData: { FirstName: 'Ada' } },
      { recordId: '11', fieldData: { FirstName: 'Grace' } }
    ];

    const dryRun = await batchService.batchUpdate(profile, 'Contacts', entries, {
      dryRun: true,
      concurrency: 2
    });

    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.attempted).toBe(0);

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'update-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .patch(`${apiBase}/layouts/Contacts/records/10`)
      .reply(200, {
        response: { modId: '1' },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .patch(`${apiBase}/layouts/Contacts/records/11`)
      .reply(500, {
        messages: [{ code: '500', message: 'Write failed' }]
      });

    const execute = await batchService.batchUpdate(profile, 'Contacts', entries, {
      dryRun: false,
      concurrency: 2
    });

    expect(execute.dryRun).toBe(false);
    expect(execute.attempted).toBe(2);
    expect(execute.successCount).toBe(1);
    expect(execute.failureCount).toBe(1);
  });
});
