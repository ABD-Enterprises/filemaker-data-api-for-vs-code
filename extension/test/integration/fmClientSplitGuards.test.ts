import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.split.test';
const api = '/fmi/data/vLatest/databases/DB';
const profile: ConnectionProfile = {
  id: 'split-guards', name: 'Test', authMode: 'direct',
  serverUrl: server, database: 'DB', username: 'admin'
};

async function harness() {
  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  await secrets.setPassword(profile.id, 'password');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { client: new FMClient(secrets, logger), secrets };
}

describe('fmClient split regression guards', () => {
  it.each(['layouts', 'metadata'] as const)('stops after one re-login and one retry when %s always returns HTTP 401', async (operation) => {
    const { client } = await harness();
    const controller = new AbortController();
    let logins = 0;
    const authorizations: string[] = [];
    const login = nock(server).persist().post(`${api}/sessions`).reply(() => {
      logins += 1;
      // Keep an unbounded-retry mutation finite. This is never reached by the correct client.
      if (logins > 2) controller.abort();
      return [200, { response: { token: `token-${logins}` }, messages: [{ code: '0', message: 'OK' }] }];
    });
    const path = operation === 'layouts' ? '/layouts' : '/layouts/Contacts';
    const rejected = nock(server).persist().get(`${api}${path}`).reply(function () {
      authorizations.push(String(this.req.headers.authorization));
      return [401, { response: {}, messages: [{ code: '952', message: 'Invalid token' }] }];
    });
    nock(server).delete(`${api}/sessions/token-1`).reply(200, {
      response: {}, messages: [{ code: '0', message: 'OK' }]
    });

    try {
      const result = operation === 'layouts'
        ? client.listLayouts(profile, { signal: controller.signal })
        : client.getLayoutMetadata(profile, 'Contacts', { signal: controller.signal });
      await expect(result).rejects.toMatchObject({ status: 401, code: '952' });
      expect(logins).toBe(2); // initial login plus exactly one re-login
      expect(authorizations).toEqual(['Bearer token-1', 'Bearer token-2']);
    } finally {
      login.persist(false);
      rejected.persist(false);
    }
  });

  it.each(['7', undefined])('sends the container upload record version on the wire when supplied (%s)', async (modId) => {
    const { client, secrets } = await harness();
    await secrets.setSessionToken(profile.id, 'upload-token');
    let query: Record<string, unknown> | undefined;
    const upload = nock(server)
      .post(`${api}/layouts/%20Contacts%20/records/42/containers/%20Photo%20/1`)
      .query((actual) => { query = actual; return true; })
      .matchHeader('authorization', 'Bearer upload-token')
      .matchHeader('content-type', /^multipart\/form-data; boundary=/)
      .reply(200, { response: {}, messages: [{ code: '0', message: 'OK' }] });

    await client.uploadContainer(profile, ' Contacts ', '42', ' Photo ', {
      fileName: 'photo.png', contentType: 'image/png', content: Buffer.from('photo')
    }, { modId });

    expect(upload.isDone()).toBe(true);
    expect(query).toEqual(modId === undefined ? {} : { modId });
  });
});
