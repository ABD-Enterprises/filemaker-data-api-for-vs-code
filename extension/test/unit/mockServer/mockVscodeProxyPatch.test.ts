import net, { type AddressInfo, type Socket } from 'net';
import os from 'os';

import axios from 'axios';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { inspectServerCertificate } from '../../../src/services/certificateInspect';
import { FMClient } from '../../../src/services/fmClient';
import { SecretStore } from '../../../src/services/secretStore';
import type { ConnectionProfile } from '../../../src/types/fm';
import { installVscodeProxyPatch } from '../../helpers/vscodeProxyPatch';
import { InMemorySecretStorage } from '../mocks';
import { hasOpenssl, startMockProcess, type RunningMock } from './mockHelper';

const lan = Object.values(os.networkInterfaces()).flat().find((info) => info?.family === 'IPv4' && !info.internal)?.address;
if (!lan) console.warn('Real VS Code proxy-patch TLS test skipped: no non-loopback IPv4 address is available.');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

/** A TCP relay lets the unchanged loopback-only mock be reached through a real LAN address. */
describe.skipIf(!lan || !hasOpenssl)('real VS Code proxy patch with the Claris default certificate over LAN IPv4', () => {
  let mock: RunningMock;
  let relay: net.Server;
  const sockets = new Set<Socket>();
  let serverUrl: string;
  let pin: string;

  beforeAll(async () => {
    nock.restore();
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) vi.stubEnv(name, undefined);
    mock = await startMockProcess({ TLS: 'claris-default-cert', ADMIN_PORT: '0' });
    relay = net.createServer((incoming) => {
      const upstream = net.connect(Number(new URL(mock.baseUrl).port), '127.0.0.1');
      for (const socket of [incoming, upstream]) {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      }
      incoming.on('error', () => upstream.destroy());
      upstream.on('error', () => incoming.destroy());
      incoming.pipe(upstream).pipe(incoming);
    });
    await new Promise<void>((resolve, reject) => {
      relay.once('error', reject);
      relay.listen(0, lan, resolve);
    });
    serverUrl = `https://${lan}:${(relay.address() as AddressInfo).port}`;
    pin = (await inspectServerCertificate(serverUrl)).sha256;
  }, 30000);

  afterAll(async () => {
    sockets.forEach((socket) => socket.destroy());
    if (relay?.listening) await new Promise<void>((resolve) => relay.close(() => resolve()));
    await mock?.stop();
    vi.unstubAllEnvs();
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });

  function profile(extra: Partial<ConnectionProfile> = {}): ConnectionProfile {
    return { id: 'patch', name: 'LAN TLS', authMode: 'direct', serverUrl, database: 'Quality', username: 'tester', ...extra };
  }
  async function client(): Promise<FMClient> {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('patch', 'testpass1');
    // Only the HTTP Host header is loopback: the actual connection and VS Code proxy decision use
    // the LAN IPv4 URL. The mock's DNS-rebinding guard deliberately refuses other Host headers.
    const http = axios.create({ headers: { Host: new URL(mock.baseUrl).host } });
    return new FMClient(secrets, logger, 3000, http);
  }
  async function counts(): Promise<unknown> {
    const state = await (await fetch(`${mock.adminUrl}/__admin/state`)).json() as { requests: number; sessionPosts: number };
    return { requests: state.requests, sessionPosts: state.sessionPosts };
  }

  it.each(['override', 'fallback', 'on', 'off'] as const)('%s: good pin signs in repeatedly, wrong pin sends no credentials, unpinned is explained', async (mode) => {
    const restore = installVscodeProxyPatch(mode);
    try {
      const pinned = profile({ pinnedCertSha256: pin });
      for (let i = 0; i < 3; i++) {
        const c = await client();
        expect((await c.getProductInfo(pinned)).name).toBeTruthy();
        expect(await c.createSession(pinned)).toBeTruthy();
        expect((await c.listLayouts(pinned)).length).toBeGreaterThan(0);
        await c.deleteSession(pinned);
      }
      const before = await counts();
      await expect((await client()).createSession(profile({ pinnedCertSha256: pin === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64) }))).rejects.toMatchObject({ networkCode: 'FM_CERT_PIN_MISMATCH' });
      expect(await counts()).toEqual(before); // no HTTP request at all, including auth or body
      await expect((await client()).createSession(profile())).rejects.toMatchObject({
        networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        message: expect.stringMatching(/FileMaker Server's default certificate is self-signed.*You can trust this certificate/)
      });
      expect(await counts()).toEqual(before);
      expect(await (await client()).createSession(profile({ allowSelfSigned: true }))).toBeTruthy();
    } finally {
      restore();
    }
  }, 20000);
});
