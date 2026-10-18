import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FMClient, type SessionHealth } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { startTlsServer } from '../helpers/tlsServer';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const body = (response: Record<string, unknown>, code = '0') => JSON.stringify({ response, messages: [{ code, message: 'x' }] });

describe('session health shown by the status bar', () => {
  const servers: Array<{ close(cb?: () => void): unknown }> = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
  });

  async function plain(handler: (url: string, method: string) => { status: number; body: string }): Promise<string> {
    const server: Server = createServer((request, response) => {
      const answer = handler(request.url ?? '', request.method ?? 'GET');
      response.statusCode = answer.status;
      response.setHeader('Content-Type', 'application/json');
      response.end(answer.body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function client(serverUrl: string) {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    const fm = new FMClient(secrets, logger, 3000);
    const seen: Array<SessionHealth | undefined> = [];
    fm.onHealthChange((_id, health) => seen.push(health));
    const profile: ConnectionProfile = { id: 'p1', name: 'T', authMode: 'direct', serverUrl, database: 'Sales', username: 'u' };
    return { fm, profile, seen };
  }

  it('nothing is known before a request', async () => {
    const { fm } = await client('http://127.0.0.1:1');
    expect(fm.getHealth('p1')).toBeUndefined();
  });

  it('goes connecting, then connected, and is cleared by a disconnect', async () => {
    const url = await plain((path, method) =>
      path.endsWith('/sessions') && method === 'POST' ? { status: 200, body: body({ token: 't' }) } : { status: 200, body: body({}) }
    );
    const { fm, profile, seen } = await client(url);
    await fm.createSession(profile);
    expect(seen.map((health) => health?.state)).toEqual(['connecting', 'connected']);
    expect(fm.getHealth('p1')?.state).toBe('connected');
    await fm.deleteSession(profile);
    expect(fm.getHealth('p1')).toBeUndefined();
  });

  it('rejected credentials show "auth-failed" with FileMaker\'s message', async () => {
    const url = await plain(() => ({ status: 401, body: body({}, '212') }));
    const { fm, profile } = await client(url);
    await expect(fm.createSession(profile)).rejects.toThrow();
    expect(fm.getHealth('p1')).toMatchObject({ state: 'auth-failed' });
    expect(fm.getHealth('p1')?.message).toMatch(/\[212\]/);
  });

  it('a refused connection shows "unreachable"', async () => {
    const url = await plain(() => ({ status: 200, body: '{}' }));
    const { fm, profile } = await client(url);
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
    await expect(fm.createSession(profile)).rejects.toThrow();
    expect(fm.getHealth('p1')?.state).toBe('unreachable');
  });

  it('a web page where the Data API should be shows "unreachable"', async () => {
    const url = await plain(() => ({ status: 200, body: '<html></html>' }));
    const { fm, profile } = await client(url);
    await expect(fm.createSession(profile)).rejects.toThrow();
    expect(fm.getHealth('p1')?.state).toBe('unreachable');
  });

  it('a certificate problem shows "certificate"', async () => {
    const key = newKeyPair();
    const cert = makeCertificate({ subjectCn: 'localhost', altNames: ['localhost'], notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: key });
    const tlsServer = await startTlsServer({ key, chain: [cert] });
    servers.push({ close: (done) => void tlsServer.close().then(() => done?.()) });
    const { fm, profile } = await client(`https://localhost:${tlsServer.port}`);
    await expect(fm.createSession(profile)).rejects.toThrow();
    expect(fm.getHealth('p1')).toMatchObject({ state: 'certificate' });
  });

  it('a FileMaker answer such as "layout is missing" or a privilege refusal proves the connection works', async () => {
    const url = await plain((path, method) => {
      if (path.endsWith('/sessions') && method === 'POST') return { status: 200, body: body({ token: 't' }) };
      return { status: 500, body: body({}, '105') };
    });
    const { fm, profile } = await client(url);
    await fm.createSession(profile);
    await expect(fm.findRecords(profile, 'Nope', { query: [{ a: 1 }] })).rejects.toThrow(/\[105\]/);
    expect(fm.getHealth('p1')?.state).toBe('connected');
  });

  it.each([502, 503, 504, 500])('a gateway answer (HTTP %i, no FileMaker code) shows "unreachable", not "connected"', async (status) => {
    const url = await plain((path, method) =>
      path.endsWith('/sessions') && method === 'POST' ? { status: 200, body: body({ token: 't' }) } : { status, body: '<html>gateway</html>' }
    );
    const { fm, profile } = await client(url);
    await fm.createSession(profile);
    expect(fm.getHealth('p1')?.state).toBe('connected');
    await expect(fm.findRecords(profile, 'L', { query: [{ a: 1 }] })).rejects.toThrow();
    expect(fm.getHealth('p1')?.state).toBe('unreachable');
  });

  it('a cancelled request leaves the last known state alone', async () => {
    const url = await plain((path, method) =>
      path.endsWith('/sessions') && method === 'POST' ? { status: 200, body: body({ token: 't' }) } : { status: 200, body: body({ layouts: [] }) }
    );
    const { fm, profile } = await client(url);
    await fm.createSession(profile);
    const before = fm.getHealth('p1');
    const controller = new AbortController();
    controller.abort();
    await expect(fm.listLayouts(profile, { signal: controller.signal })).rejects.toThrow();
    expect(fm.getHealth('p1')).toEqual(before);
    expect(fm.getHealth('p1')?.state).toBe('connected');
  });
});
