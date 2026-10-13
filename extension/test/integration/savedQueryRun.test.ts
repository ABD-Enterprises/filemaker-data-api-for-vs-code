import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { executeSavedQueryAgainstClient } from '../../src/services/savedQueryRunner';
import { SavedQueriesStore } from '../../src/services/savedQueriesStore';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemoryMemento, InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';
const apiBase = '/fmi/data/vLatest/databases/TestDB';

function createProfile(): ConnectionProfile {
  return {
    id: 'saved-query-profile',
    name: 'Saved Query Profile',
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
  await secretStore.setPassword('saved-query-profile', 'password123');

  return new FMClient(secretStore, logger, 5_000);
}

describe('saved query run integration (mocked HTTP)', () => {
  it('loads a saved query and executes findRecords', async () => {
    const profile = createProfile();
    const fmClient = await createClient();

    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();

    const savedQueriesStore = new SavedQueriesStore(globalState as never, workspaceState as never, {
      getScope: () => 'workspace'
    });

    await savedQueriesStore.saveSavedQuery({
      id: 'query-1',
      name: 'Find Ada',
      profileId: profile.id,
      database: profile.database,
      layout: 'Contacts',
      findJson: [{ FirstName: 'Ada' }],
      sortJson: [{ fieldName: 'FirstName', sortOrder: 'ascend' }],
      limit: 5,
      offset: 0,
      createdAt: new Date().toISOString()
    });

    const saved = await savedQueriesStore.getSavedQuery('query-1');
    expect(saved).toBeDefined();
    if (!saved) {
      throw new Error('Expected saved query to exist.');
    }

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'saved-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .post(`${apiBase}/layouts/Contacts/_find`)
      .reply(200, {
        response: {
          data: [
            {
              recordId: '100',
              fieldData: { FirstName: 'Ada' }
            }
          ]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    const execution = await executeSavedQueryAgainstClient(saved, profile, fmClient);

    expect(execution.request.query).toEqual([{ FirstName: 'Ada' }]);
    expect(execution.result.data[0]?.recordId).toBe('100');
  });
});
