import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { FMClientError } from '../../src/services/errors';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';
const apiBase = '/fmi/data/vLatest/databases/TestDB';

function createProfile(): ConnectionProfile {
  return {
    id: 'script-profile',
    name: 'Script',
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
  await secretStore.setPassword('script-profile', 'password123');

  return new FMClient(secretStore, logger, 5_000);
}

describe('runScript integration (mocked HTTP)', () => {
  it('runs script successfully when endpoint is available', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'script-token-1' }, messages: [{ code: '0', message: 'OK' }] });

    // Claris Data API Guide, "Run a script": GET .../script/<script>?script.param=<text>
    nock(server)
      .get(`${apiBase}/layouts/Contacts/script/MyScript`)
      .query({ 'script.param': 'abc' })
      .reply(200, {
        response: {
          scriptResult: 'done',
          scriptError: '0'
        },
        messages: [{ code: '0', message: 'Command is valid.' }]
      });

    const result = await client.runScript(profile, {
      layout: 'Contacts',
      scriptName: 'MyScript',
      scriptParam: 'abc'
    });

    expect(result.response).toMatchObject({ scriptResult: 'done' });
    expect(result.messages[0]?.code).toBe('0');
  });

  it('maps unsupported script endpoints to SCRIPT_UNSUPPORTED', async () => {
    const profile = createProfile();
    const client = await createClient();

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'script-token-2' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .get(`${apiBase}/layouts/Contacts/script/MyScript`)
      .reply(501, {
        messages: [{ code: '501', message: 'Not Implemented' }]
      });

    // The alternative reads at most one record, with the script in the GET query.
    nock(server)
      .get(`${apiBase}/layouts/Contacts/records`).query({ script: 'MyScript', _limit: 1 })
      .reply(501, {
        messages: [{ code: '501', message: 'Not Implemented' }]
      });

    let caught: unknown;

    try {
      await client.runScript(profile, {
        layout: 'Contacts',
        scriptName: 'MyScript'
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FMClientError);
    expect((caught as FMClientError).code).toBe('SCRIPT_UNSUPPORTED');
  });
});
