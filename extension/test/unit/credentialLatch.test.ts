import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { isRetryableConnectError } from '../../src/commands/index';
import { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const json = (response: Record<string, unknown>, code = '0', message = 'OK') => JSON.stringify({ response, messages: [{ code, message }] });

describe('failed sign-ins do not repeat on their own', () => {
  const servers: Server[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  interface Rig {
    loginPosts: () => number;
    dataGets: () => number;
    fm: FMClient;
    profile: ConnectionProfile;
    secrets: SecretStore;
    setLogin: (status: number, code: string, message?: string) => void;
    setClock: (ms: number) => void;
    acceptPassword: (password: string) => void;
    revokeTokens: () => void;
  }

  async function rig(initial: { status: number; code: string } = { status: 401, code: '212' }): Promise<Rig> {
    let login = { status: initial.status, code: initial.code, message: 'Invalid user account and/or password' };
    let accepted: string | undefined;
    let posts = 0;
    let gets = 0;
    const valid = new Set<string>();
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.endsWith('/sessions') && request.method === 'POST') {
        posts += 1;
        const supplied = Buffer.from((request.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString().split(':')[1];
        if (accepted !== undefined && supplied === accepted) {
          valid.add('tok');
          response.end(json({ token: 'tok' }));
          return;
        }
        response.statusCode = login.status;
        response.end(json({}, login.code, login.message));
        return;
      }
      gets += 1;
      if (!valid.has((request.headers.authorization ?? '').replace('Bearer ', ''))) {
        response.statusCode = 401;
        response.end(json({}, '952', 'Invalid FileMaker Data API token'));
        return;
      }
      response.end(json({ layouts: [{ name: 'A' }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'stored-password');
    let clock = 1_000_000;
    const fm = new FMClient(secrets, logger, 3000, undefined, undefined, undefined, undefined, () => ({ now: () => clock }));
    return {
      loginPosts: () => posts,
      dataGets: () => gets,
      fm,
      secrets,
      profile: { id: 'p1', name: 'T', authMode: 'direct', serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, database: 'Sales', username: 'u' },
      setLogin: (status, code, message = 'x') => (login = { status, code, message }),
      setClock: (ms) => (clock = ms),
      acceptPassword: (password) => (accepted = password),
      revokeTokens: () => valid.clear()
    };
  }

  const settle = async (promise: Promise<unknown>): Promise<FMClientError | undefined> => {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return error as FMClientError;
    }
  };

  it('five actions with a bad stored password make exactly one failed login', async () => {
    const r = await rig();
    const errors: Array<FMClientError | undefined> = [];
    for (let i = 0; i < 5; i += 1) {
      errors.push(await settle(r.fm.listLayouts(r.profile)));
    }
    expect(r.loginPosts()).toBe(1);
    expect(errors[0]?.code).toBe('212');
    for (const error of errors.slice(1)) {
      expect(error?.code).toBe('212');
      expect(error?.message).toMatch(/Sign-in is paused.*Edit the connection.*Connect/s);
      expect(error?.isRetryable).toBe(false);
    }
    expect(r.fm.isSignInPaused('p1')).toBe(true);
  });

  it('also when the password goes bad while a token is in use (token rejected, then login rejected)', async () => {
    const r = await rig();
    r.acceptPassword('stored-password');
    expect(await r.fm.listLayouts(r.profile)).toEqual(['A']);
    expect(r.loginPosts()).toBe(1);

    r.acceptPassword('somebody-changed-it');
    r.revokeTokens();
    for (let i = 0; i < 5; i += 1) {
      r.fm.invalidateProfileCache('p1'); // the layout list is cached for a minute; ask the server each time
      await settle(r.fm.listLayouts({ ...r.profile }));
    }
    // One login that succeeded earlier + exactly one that failed.
    expect(r.loginPosts()).toBe(2);
  });

  it('parallel requests share one login attempt', async () => {
    const r = await rig();
    const results = await Promise.all(Array.from({ length: 6 }, () => settle(r.fm.listLayouts(r.profile))));
    expect(r.loginPosts()).toBe(1);
    expect(results.every((error) => error?.code === '212')).toBe(true);
  });

  it.each([['210', 401], ['211', 401], ['214', 401], ['212', 500]])('error %s (HTTP %i) pauses automatic sign-ins', async (code, status) => {
    const r = await rig({ status, code });
    await settle(r.fm.listLayouts(r.profile));
    await settle(r.fm.listLayouts(r.profile));
    expect(r.loginPosts()).toBe(1);
    expect(r.fm.isSignInPaused('p1')).toBe(true);
  });

  it('the user can still run Connect: it signs in again, and success ends the pause', async () => {
    const r = await rig();
    await settle(r.fm.listLayouts(r.profile));
    expect(r.loginPosts()).toBe(1);

    expect((await settle(r.fm.createSession(r.profile, { userInitiated: true })))?.code).toBe('212');
    expect(r.loginPosts()).toBe(2);

    r.acceptPassword('stored-password');
    await r.fm.createSession(r.profile, { userInitiated: true });
    expect(r.fm.isSignInPaused('p1')).toBe(false);
    expect(await r.fm.listLayouts(r.profile)).toEqual(['A']);
  });

  it('editing the password ends the pause by itself (no explicit reset needed)', async () => {
    const r = await rig();
    await settle(r.fm.listLayouts(r.profile));
    await r.secrets.setPassword('p1', 'a-new-password');
    r.acceptPassword('a-new-password');
    expect(await r.fm.listLayouts(r.profile)).toEqual(['A']);
    expect(r.loginPosts()).toBe(2);
  });

  it('server session limit (956): automatic sign-ins wait with growing delays; Connect goes ahead', async () => {
    const r = await rig({ status: 500, code: '956' });
    const first = await settle(r.fm.listLayouts(r.profile));
    expect(first?.code).toBe('956');
    expect(first?.isRetryable).toBe(true);
    expect(r.loginPosts()).toBe(1);

    const waiting = await settle(r.fm.listLayouts(r.profile));
    expect(waiting?.message).toMatch(/maximum number of database or Admin API sessions.*Waiting \d+ s/s);
    expect(r.loginPosts()).toBe(1);

    r.setClock(1_000_000 + 31_000);
    await settle(r.fm.listLayouts(r.profile));
    expect(r.loginPosts()).toBe(2);

    // The second delay is longer (60 s).
    r.setClock(1_000_000 + 31_000 + 40_000);
    await settle(r.fm.listLayouts(r.profile));
    expect(r.loginPosts()).toBe(2);

    await settle(r.fm.createSession(r.profile, { userInitiated: true }));
    expect(r.loginPosts()).toBe(3);
  });

  it('tells cache owners when a new sign-in or a sign-out changes what the account can see', async () => {
    const r = await rig();
    r.acceptPassword('stored-password');
    const seen: string[] = [];
    r.fm.onProfileInvalidated((id) => seen.push(id));
    await r.fm.createSession(r.profile, { userInitiated: true });
    expect(seen).toContain('p1');
    seen.length = 0;
    await r.fm.deleteSession(r.profile);
    expect(seen).toContain('p1');
  });

  it('Connect retries only what a retry can fix', () => {
    const e = (options: ConstructorParameters<typeof FMClientError>[1]) => new FMClientError('x', options);
    expect(isRetryableConnectError(e({ isRetryable: true, networkCode: 'ECONNREFUSED' }))).toBe(true);
    expect(isRetryableConnectError(e({ isRetryable: true, code: '956', status: 500 }))).toBe(true);
    expect(isRetryableConnectError(e({ isRetryable: false, status: 500, code: '802' }))).toBe(false);
    expect(isRetryableConnectError(e({ isRetryable: false, kind: 'certificate' }))).toBe(false);
    expect(isRetryableConnectError(e({ isRetryable: false, status: 401, code: '212' }))).toBe(false);
    expect(isRetryableConnectError(new Error('timeout reset'))).toBe(false);
  });
});
