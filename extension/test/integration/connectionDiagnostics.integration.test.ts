import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDiagnosticProbes, rankDiagnosticCauses, runConnectionDiagnostics } from '../../src/services/connectionDiagnostics';
import { FMClient } from '../../src/services/fmClient';
import { disposeTlsAgents } from '../../src/services/tlsAgent';

// The shipping mock's TLS modes are the oracle, rather than another set of approximate fixtures.
const tlsModule = '../../test/mock-server/lib/tls.mjs';
const { makeCerts } = await import(tlsModule) as { makeCerts(mode: string, dir: string): { key: string; cert: string; caPath: string } };

const mockModule = '../../test/mock-server/server.mjs';
const { startMock } = await import(mockModule) as { startMock(options: { env: Record<string, string> }): Promise<{
  baseUrl: string; close(): Promise<void>;
  engine: { admin(method: string, path: string, query: URLSearchParams, body: object): { json: { sessionPosts: number; requests: number; sessions: number } } };
}> };

describe('connection diagnosis against mock TLS modes (requires real sockets)', () => {
  beforeAll(() => nock.restore());
  afterAll(() => { disposeTlsAgents(); nock.activate(); nock.disableNetConnect(); });
  it('reaches the shipping mock productInfo endpoint without creating a session', async () => {
    const mock = await startMock({ env: { PORT: '0', ADMIN_PORT: '', TLS: 'off' } });
    try {
      const fm = new FMClient({} as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 3000);
      const report = await runConnectionDiagnostics({ id: 'mock', name: 'Mock', serverUrl: mock.baseUrl, database: '', authMode: 'direct' },
        { proxySupport: 'fallback', proxyConfigured: false, systemCertificates: false, proxyVariables: [], hostReplaced: false }, createDiagnosticProbes(fm), new AbortController().signal, 4000);
      expect(report.http).toBe(200); expect(report.fmCode).toBe('0');
      expect(report.steps.at(-1)?.text).toContain('FileMaker Data API Engine');
      expect(mock.engine.admin('GET', '/__admin/state', new URLSearchParams(), {}).json).toMatchObject({ requests: 1, sessions: 0, sessionPosts: 0 });
    } finally { await mock.close(); }
  });
  it.each([
    ['claris-default-cert', false, /No host names listed.*trust it by fingerprint/],
    ['expired', true, /certificate has expired/],
    ['wronghost', true, /different server name/],
    ['ca', false, /does not trust the certificate/],
    ['ca', true, /checks passed without signing in/]
  ] as const)('%s (trust CA: %s)', async (mode, trustCa, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-diagnose-'));
    let server: Server | undefined;
    const requests: Array<{ method?: string; path?: string; headers: Record<string, unknown> }> = [];
    try {
      const certs = makeCerts(mode, dir);
      server = createServer({ key: readFileSync(certs.key), cert: readFileSync(certs.cert) }, (req, res) => {
        requests.push({ method: req.method, path: req.url, headers: req.headers });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ response: { productInfo: { name: 'FileMaker Server', version: '22' } }, messages: [{ code: '0' }] }));
      });
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
      const port = (server.address() as AddressInfo).port;
      const secrets = { getPassword: vi.fn(), getToken: vi.fn(), getProxyApiKey: vi.fn() };
      const fm = new FMClient(secrets as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 3000);
      const report = await runConnectionDiagnostics({ id: 'diagnosis', name: 'Mock', authMode: 'direct', serverUrl: `https://localhost:${port}`, database: 'DB', caBundlePath: trustCa ? certs.caPath : undefined },
        { proxySupport: 'fallback', proxyConfigured: false, systemCertificates: false, proxyVariables: [], hostReplaced: false }, createDiagnosticProbes(fm), new AbortController().signal, 4000);
      expect(rankDiagnosticCauses(report)[0]).toMatch(expected);
      if (mode === 'claris-default-cert') {
        expect(report.certificate).toMatchObject({ noNames: true, chainBeyondLeaf: false, selfSigned: false });
        expect(requests).toHaveLength(0);
      }
      if (mode === 'ca' && trustCa) {
        expect(report.http).toBe(200); expect(report.fmCode).toBe('0'); expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: 'GET', path: '/fmi/data/vLatest/productInfo' });
      }
      for (const req of requests) { expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined(); }
      expect(secrets.getPassword).not.toHaveBeenCalled(); expect(secrets.getToken).not.toHaveBeenCalled(); expect(secrets.getProxyApiKey).not.toHaveBeenCalled();
    } finally {
      if (server?.listening) await new Promise<void>((resolve) => { server!.closeAllConnections(); server!.close(() => resolve()); });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
