import { createServer, type Server } from 'https';
import { TLSSocket } from 'tls';
import { get } from 'https';
import type { AddressInfo } from 'net';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { PinnedCertificateAgent, httpsTransportFor, normalizeSha256 } from '../../src/services/tlsAgent';
import { DAY, keyToPem, makeCertificate, newKeyPair } from '../helpers/x509';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const now = Date.now();
const material = () => {
  const key = newKeyPair();
  return { key, cert: makeCertificate({ subjectCn: 'fm.internal', altNames: ['fm.internal'], notBefore: new Date(now - DAY), notAfter: new Date(now + DAY), subjectKey: key }) };
};
const pinOf = (m: ReturnType<typeof material>) => normalizeSha256(m.cert.fingerprint256) as string;

describe('a pinned agent works on every connection, including after TLS sessions could have been resumed', () => {
  const servers: Server[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      })
    );
  });

  async function listen(m: ReturnType<typeof material>, version: 'TLSv1.2' | 'TLSv1.3', port = 0): Promise<{ port: number; requests: string[]; connections: () => number }> {
    const requests: string[] = [];
    let connections = 0;
    const server = createServer({ key: keyToPem(m.key), cert: m.cert.pem, minVersion: version, maxVersion: version }, (request, response) => {
      requests.push(String(request.url));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ response: { token: 'test-token' }, messages: [{ code: '0', message: 'OK' }] }));
    });
    server.on('secureConnection', () => (connections += 1));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, requests, connections: () => connections };
  }

  const fetchOnce = (port: number, agent: PinnedCertificateAgent): Promise<string> =>
    new Promise((resolve) => {
      get({ host: '127.0.0.1', port, path: '/', agent }, (response) => {
        response.resume();
        response.on('end', () => resolve('OK'));
      }).on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    });

  describe.each([
    ['TLSv1.2', false],
    ['TLSv1.2', true],
    ['TLSv1.3', false],
    ['TLSv1.3', true]
  ] as const)('%s, keep-alive %s', (version, keepAlive) => {
    it('accepts the pinned certificate on ten sequential requests through one agent', async () => {
      const m = material();
      const server = await listen(m, version);
      const agent = new PinnedCertificateAgent({ keepAlive }, { sha256: pinOf(m), allowExpired: false });
      const results: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        results.push(await fetchOnce(server.port, agent));
      }
      expect(results).toEqual(Array(10).fill('OK'));
      expect(server.requests).toHaveLength(10);
      // Without a session cache every new connection is a full handshake; with keep-alive they are reused.
      if (!keepAlive) expect(server.connections()).toBe(10);
      agent.destroy();
    });

    it('refuses a server with another certificate on every request, and sends nothing', async () => {
      const server = await listen(material(), version);
      const agent = new PinnedCertificateAgent({ keepAlive }, { sha256: pinOf(material()), allowExpired: false });
      const results: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        results.push(await fetchOnce(server.port, agent));
      }
      expect(results).toEqual(Array(6).fill('FM_CERT_PIN_MISMATCH'));
      expect(server.requests).toHaveLength(0);
      agent.destroy();
    });

    it('refuses the requests that come after the certificate is swapped', async () => {
      const original = material();
      const first = await listen(original, version);
      const agent = new PinnedCertificateAgent({ keepAlive }, { sha256: pinOf(original), allowExpired: false });
      expect([await fetchOnce(first.port, agent), await fetchOnce(first.port, agent), await fetchOnce(first.port, agent)]).toEqual(['OK', 'OK', 'OK']);

      const [old] = servers.splice(0);
      (old as Server).closeAllConnections();
      await new Promise((resolve) => (old as Server).close(resolve));
      const swapped = await listen(material(), version, first.port); // same address, different certificate
      const after: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        after.push(await fetchOnce(swapped.port, agent));
      }
      expect(after).toEqual(Array(4).fill('FM_CERT_PIN_MISMATCH'));
      expect(swapped.requests).toHaveLength(0);
      agent.destroy();
    });
  });

  it.each(['TLSv1.2', 'TLSv1.3'] as const)('the Test Connection ladder (product info, databases, sign-in, sign-out) works against a pinned %s server, repeatedly', async (version) => {
    const m = material();
    const server = await listen(m, version);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    const fm = new FMClient(secrets, logger, 3000);
    const profile = { id: 'p1', name: 'T', authMode: 'direct' as const, serverUrl: `https://127.0.0.1:${server.port}`, database: 'Sales', username: 'u', pinnedCertSha256: pinOf(m) };

    for (let round = 0; round < 3; round += 1) {
      await fm.getProductInfo(profile);
      await fm.listHostedDatabases(profile);
      expect(await fm.createSession(profile, { userInitiated: true })).toBe('test-token');
      await fm.deleteSession(profile);
    }
    expect(server.requests.length).toBeGreaterThanOrEqual(12);
  });

  it('through FMClient a wrong pin is refused on every request, with nothing delivered', async () => {
    const server = await listen(material(), 'TLSv1.2');
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    const fm = new FMClient(secrets, logger, 3000);
    const profile = { id: 'p1', name: 'T', authMode: 'direct' as const, serverUrl: `https://127.0.0.1:${server.port}`, database: 'Sales', username: 'u', pinnedCertSha256: pinOf(material()) };
    for (let i = 0; i < 4; i += 1) {
      const error = (await fm.createSession(profile, { userInitiated: true }).catch((e) => e)) as FMClientError;
      expect(error.networkCode).toBe('FM_CERT_PIN_MISMATCH');
    }
    expect(server.requests).toHaveLength(0);
  });

  it('refuses a connection that reports it resumed a session, even though the certificate is the pinned one (backstop)', async () => {
    const m = material();
    const server = await listen(m, 'TLSv1.3');
    const agent = new PinnedCertificateAgent({}, { sha256: pinOf(m), allowExpired: false });
    const original = TLSSocket.prototype.isSessionReused;
    TLSSocket.prototype.isSessionReused = () => true;
    try {
      expect(await fetchOnce(server.port, agent)).toBe('FM_CERT_PIN_MISMATCH');
    } finally {
      TLSSocket.prototype.isSessionReused = original;
    }
    expect(server.requests).toHaveLength(0);
    expect(await fetchOnce(server.port, agent)).toBe('OK'); // and a normal connection works again
    agent.destroy();
  });

  it('the pinned transport tells axios not to use a proxy of its own (the pin is checked by the agent alone)', () => {
    const m = material();
    expect(httpsTransportFor({ pinnedCertSha256: pinOf(m) }, 'https://fm.example.com')).toMatchObject({ proxy: false });
    expect(httpsTransportFor({}, 'https://fm.example.com')).not.toHaveProperty('proxy');
    // A pin has no meaning for plain http, so no change there.
    expect(httpsTransportFor({ pinnedCertSha256: pinOf(m) }, 'http://fm.example.com')).not.toHaveProperty('proxy');
  });
});
