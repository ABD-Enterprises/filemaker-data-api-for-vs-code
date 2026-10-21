import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { createSelfTestClient } from '../../src/services/serverSelfTestClient';
import { SecretStore } from '../../src/services/secretStore';
import { InMemorySecretStorage } from './mocks';
import type { ConnectionProfile } from '../../src/types/fm';

const profile: ConnectionProfile = { id: 'self', name: 'Self', authMode: 'direct', serverUrl: 'https://self.example', username: 'tester', database: 'Sales' };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const envelope = (response: unknown, code = '0', message = 'OK') => ({ response, messages: [{ code, message }] });
const root = '/fmi/data/vLatest';
const db = `${root}/databases/Sales`;

async function setup() {
  const stored = new SecretStore(new InMemorySecretStorage() as never);
  await stored.setPassword(profile.id, 'secret-password');
  await stored.setSessionToken(profile.id, 'existing-user-session');
  const client = await createSelfTestClient(profile, stored, logger, 1000);
  return { stored, client };
}

describe('real self-test client (in-memory HTTP interception, no sockets)', () => {
  it('uses product info without auth and logs in with stored credentials in a separate session', async () => {
    const { stored, client } = await setup();
    const server = nock(profile.serverUrl)
      .get(`${root}/productInfo`).matchHeader('authorization', (value) => value === undefined)
      .reply(200, envelope({ productInfo: { version: '21.0' } }))
      .post(`${db}/sessions`).basicAuth({ user: 'tester', pass: 'secret-password' })
      .reply(200, envelope({ token: 'fresh-session' }));
    await client.getProductInfo(profile);
    expect(client.observation()).toMatchObject({ status: 200, code: '0' });
    await client.createSession(profile);
    expect(await stored.getSessionToken(profile.id)).toBe('existing-user-session');
    expect(client.scrub('secret-password fresh-session')).toBe('*** ***');
    expect(server.isDone()).toBe(true);
  });

  it.each([404, 500])('preserves HTTP %s / 401 before normal find normalization, with exact URL names', async (status) => {
    const { client } = await setup();
    nock(profile.serverUrl).post(`${db}/sessions`).reply(200, envelope({ token: 'fresh-session' }));
    await client.createSession(profile);
    const server = nock(profile.serverUrl).post(`${db}/layouts/%20Contacts%20/_find`, { query: [{ ' Name ': '==impossible' }], limit: 1 })
      .reply(status, envelope({}, '401', 'No records match the request'));
    expect(await client.findRecords(profile, ' Contacts ', { query: [{ ' Name ': '==impossible' }], limit: 1 })).toMatchObject({ data: [] });
    expect(client.observation()).toMatchObject({ status, code: '401', message: 'No records match the request' });
    expect(server.isDone()).toBe(true);
  });

  it('does not silently log in again when probing the logged-out token', async () => {
    const { client } = await setup();
    const server = nock(profile.serverUrl).get(`${db}/layouts`).matchHeader('authorization', 'Bearer old-token')
      .reply(401, envelope({}, '952', 'Invalid FileMaker Data API token'));
    await expect(client.verifyLoggedOut(profile, 'old-token')).rejects.toThrow();
    expect(client.observation()).toMatchObject({ status: 401, code: '952' });
    expect(server.isDone()).toBe(true);
  });

  it('reports a failed logout even though normal Disconnect swallows it', async () => {
    const { client, stored } = await setup();
    nock(profile.serverUrl).post(`${db}/sessions`).reply(200, envelope({ token: 'fresh-session' }))
      .delete(`${db}/sessions/fresh-session`).reply(500, envelope({}, '9', 'Insufficient privileges'));
    await client.createSession(profile);
    client.resetObservation();
    await expect(client.deleteSession(profile)).rejects.toMatchObject({ status: 500, code: '9' });
    expect(await stored.getSessionToken(profile.id)).toBe('existing-user-session');
  });

  it('scrubs opaque credentials echoed without labels as well as JSON escaped credentials', async () => {
    const { client } = await setup();
    nock(profile.serverUrl).post(`${db}/sessions`).reply(200, envelope({ token: 'opaque/session-secret' }));
    await client.createSession(profile);
    expect(client.scrub('echo secret-password / opaque/session-secret')).toBe('echo *** / ***');
  });
});
