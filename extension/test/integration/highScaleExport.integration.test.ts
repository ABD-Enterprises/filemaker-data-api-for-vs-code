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

function createProfile(): ConnectionProfile {
  return {
    id: 'high-scale-profile',
    name: 'HighScale',
    authMode: 'direct',
    serverUrl: server,
    database: 'ScaleDB',
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
  await secretStore.setPassword('high-scale-profile', 'password123');

  return new FMClient(secretStore, logger, 5_000);
}

describe('high-scale export integration', () => {
  it('forces JSONL behavior in high-scale mode', async () => {
    const profile = createProfile();
    const client = await createClient();

    const batchService = new BatchService(client, {
      getPerformanceMode: () => 'high-scale'
    });

    const root = await mkdtemp(join(tmpdir(), 'fm-high-scale-'));
    const outputPath = join(root, 'contacts.csv');

    nock(server)
      .post('/fmi/data/vLatest/databases/ScaleDB/sessions')
      .reply(200, {
        response: { token: 'scale-token' },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .post('/fmi/data/vLatest/databases/ScaleDB/layouts/Contacts/_find')
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
      .post('/fmi/data/vLatest/databases/ScaleDB/layouts/Contacts/_find')
      .reply(200, {
        response: {
          data: []
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
        format: 'csv',
        maxRecords: 100,
        pageSize: 2
      }
    );

    expect(result.format).toBe('jsonl');
    const content = await readFile(outputPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('recordId');
  });
});
