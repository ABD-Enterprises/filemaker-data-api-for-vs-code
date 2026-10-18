import { createServer as createHttpServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import net from 'net';
import type { Duplex } from 'stream';

import axios from 'axios';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { createHttpsAgentForProfile, normalizeSha256 } from '../../src/services/tlsAgent';
import type { ConnectionProfile } from '../../src/types/fm';
import { startTlsServer, type TestTlsServer } from '../helpers/tlsServer';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const now = Date.now();

const caKey = newKeyPair();
const ca = makeCertificate({ subjectCn: 'Proxy Test CA', notBefore: new Date(now - DAY), notAfter: new Date(now + 30 * DAY), subjectKey: caKey, isCa: true });

function leaf(options: { signedByCa?: boolean } = {}) {
  const key = newKeyPair();
  return {
    key,
    cert: makeCertificate({
      subjectCn: 'localhost',
      altNames: ['localhost'],
      notBefore: new Date(now - DAY),
      notAfter: new Date(now + 30 * DAY),
      subjectKey: key,
      issuer: options.signedByCa ? { cn: 'Proxy Test CA', key: caKey } : undefined
    })
  };
}

describe('certificate checks when an HTTP proxy is configured', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  const saved: Record<string, string | undefined> = {};
  let connects: string[];

  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  beforeEach(async () => {
    connects = [];
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  /** A CONNECT proxy that tunnels everything to `target`, whatever host was asked for. */
  async function startProxy(target: number): Promise<string> {
    const proxy: Server = createHttpServer();
    const open = new Set<Duplex>();
    proxy.on('connect', (_request, socket) => {
      connects.push(String(_request.url));
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      const upstream = net.connect(target, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      open.add(upstream);
      upstream.on('close', () => open.delete(upstream));
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    servers.push({
      close: () => {
        open.forEach((socket) => socket.destroy());
        return new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    });
    return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  }

  async function origin(material: ReturnType<typeof leaf>): Promise<TestTlsServer> {
    const server = await startTlsServer({ key: material.key, chain: [material.cert] });
    servers.push(server);
    return server;
  }

  function useProxy(url: string): void {
    process.env.HTTPS_PROXY = url;
    process.env.https_proxy = url;
  }

  async function login(server: TestTlsServer, extra: Partial<ConnectionProfile>, host = 'localhost'): Promise<string | FMClientError> {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'the-password');
    try {
      return await new FMClient(secrets, logger, 3000).createSession({
        id: 'p1', name: 'T', authMode: 'direct', serverUrl: `https://${host}:${server.port}`, database: 'Sales', username: 'u', ...extra
      });
    } catch (error) {
      return error as FMClientError;
    }
  }

  describe('a pinned certificate', () => {
    it('is refused with a clear message before anything is sent, whatever the origin presents', async () => {
      const pinnedMaterial = leaf();
      const server = await origin(leaf()); // a different certificate than the pinned one
      useProxy(await startProxy(server.port));

      const result = (await login(server, { pinnedCertSha256: normalizeSha256(pinnedMaterial.cert.fingerprint256) })) as FMClientError;
      expect(result.code).toBe('PIN_THROUGH_PROXY');
      expect(result.message).toMatch(/proxy.*pinned.*NO_PROXY/s);
      expect(connects).toEqual([]); // not even a tunnel was opened
      expect(server.requests).toHaveLength(0); // and no credentials reached the server
    });

    it('is also refused for the matching certificate (it cannot be checked through a proxy)', async () => {
      const material = leaf();
      const server = await origin(material);
      useProxy(await startProxy(server.port));
      const result = (await login(server, { pinnedCertSha256: normalizeSha256(material.cert.fingerprint256) })) as FMClientError;
      expect(result.code).toBe('PIN_THROUGH_PROXY');
      expect(server.requests).toHaveLength(0);
    });

    it('works when NO_PROXY keeps the server out of the proxy, and still refuses another certificate', async () => {
      const material = leaf();
      const server = await origin(material);
      useProxy(await startProxy(server.port));
      process.env.NO_PROXY = 'localhost';
      expect(await login(server, { pinnedCertSha256: normalizeSha256(material.cert.fingerprint256) })).toBe('test-token');
      expect(connects).toEqual([]);

      const other = await origin(leaf());
      const refused = (await login(other, { pinnedCertSha256: normalizeSha256(material.cert.fingerprint256) })) as FMClientError;
      expect(refused.networkCode).toBe('FM_CERT_PIN_MISMATCH');
      expect(other.requests).toHaveLength(0);
    });

    it('fails closed even if something hands the pinned agent to axios directly (a tunnel never skips the checks)', async () => {
      const pinnedMaterial = leaf();
      const server = await origin(leaf());
      useProxy(await startProxy(server.port));
      const agent = createHttpsAgentForProfile({ pinnedCertSha256: normalizeSha256(pinnedMaterial.cert.fingerprint256) });

      // The agent no longer advertises rejectUnauthorized:false, so the copy axios makes into its
      // tunnelling agent verifies normally; the origin's certificate is not trusted, so this fails.
      expect(agent.options.rejectUnauthorized).toBeUndefined();
      await expect(
        axios.post(`https://localhost:${server.port}/x`, {}, { headers: { Authorization: 'Basic c2VjcmV0' }, maxRedirects: 0, httpsAgent: agent, timeout: 3000 })
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('the other certificate settings keep their meaning through a proxy', () => {
    it('without any trust setting, a certificate that is not trusted is still refused', async () => {
      const server = await origin(leaf());
      useProxy(await startProxy(server.port));
      const result = (await login(server, {})) as FMClientError;
      expect(result.networkCode).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
      expect(connects.length).toBeGreaterThan(0); // it did go through the proxy
      expect(server.requests).toHaveLength(0);
    });

    it('a custom CA file is honoured through the proxy, and a certificate it did not sign is refused', async () => {
      const { writeFile, mkdtemp } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const dir = await mkdtemp((await import('path')).join(tmpdir(), 'proxy-ca-'));
      const caFile = (await import('path')).join(dir, 'ca.pem');
      await writeFile(caFile, ca.pem);

      const signed = await origin(leaf({ signedByCa: true }));
      useProxy(await startProxy(signed.port));
      expect(await login(signed, { caBundlePath: caFile })).toBe('test-token');

      const unsigned = await origin(leaf());
      useProxy(await startProxy(unsigned.port)); // this proxy tunnels to the second server
      const refused = (await login(unsigned, { caBundlePath: caFile })) as FMClientError;
      expect(refused.networkCode).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
      expect(unsigned.requests).toHaveLength(0);
    });

    it('the older allowSelfSigned flag still skips the checks, with or without a proxy (its documented behaviour)', async () => {
      const server = await origin(leaf());
      useProxy(await startProxy(server.port));
      expect(await login(server, { allowSelfSigned: true })).toBe('test-token');
    });
  });
});

