import http from 'http';
import https from 'https';
import nock from 'nock';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { httpsTransportFor } from '../../src/services/tlsAgent';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';

afterEach(() => { vi.restoreAllMocks(); if (!nock.isActive()) nock.activate(); });

describe('custom TLS uses ClientRequest instead of the replaceable request function', () => {
  it.each([{ pinnedCertSha256: 'a'.repeat(64) }, { allowSelfSigned: true }])('keeps its own agent for %j, also on repeat requests', async (profile) => {
    nock.restore();
    const first = await httpsTransportFor(profile, 'https://fm.example.test');
    const second = await httpsTransportFor(profile, 'https://fm.example.test');
    expect(first.transport).toBeDefined();
    expect(second.httpsAgent).toBe(first.httpsAgent);
    const add = vi.spyOn(first.httpsAgent as https.Agent & { addRequest(req: http.ClientRequest, options: http.RequestOptions): void }, 'addRequest').mockImplementation(() => undefined);
    const patched = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('patched request must not run'); });
    const callback = vi.fn();
    for (const config of [first, second]) {
      const req = config.transport!.request({ protocol: 'https:', hostname: 'fm.example.test', path: '/login', method: 'POST', agent: first.httpsAgent }, callback);
      expect(req).toBeInstanceOf(http.ClientRequest);
      expect((req as http.ClientRequest & { agent: https.Agent }).agent).toBe(first.httpsAgent);
      expect(req.listeners('response')).toContain(callback);
      req.destroy();
    }
    expect(add).toHaveBeenCalledTimes(2);
    expect(patched).not.toHaveBeenCalled();
  });

  it('keeps CA-only profiles on the plain axios/agent path, but a pin takes priority over a CA file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transport-ca-'));
    const file = join(dir, 'ca.pem');
    try {
      await writeFile(file, makeCertificate({ subjectCn: 'CA', notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: newKeyPair() }).pem);
      const config = httpsTransportFor({ caBundlePath: file }, 'https://fm.example.test');
      expect(config).not.toHaveProperty('transport');
      expect(config).not.toHaveProperty('proxy');
      expect(config.httpsAgent.options.ca).toContain(await readFile(file, 'utf8'));
      expect(httpsTransportFor({ caBundlePath: file, pinnedCertSha256: 'a'.repeat(64) }, 'https://fm.example.test')).toMatchObject({ proxy: false, transport: expect.any(Object) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves the supplied legacy agent, but always enforces the pin agent', () => {
    nock.restore();
    for (const profile of [{ allowSelfSigned: true }, { pinnedCertSha256: 'a'.repeat(64) }]) {
      const config = httpsTransportFor(profile, 'https://fm.example.test');
      const proxyAgent = new https.Agent();
      const dispatch = vi.spyOn(proxyAgent as https.Agent & { addRequest(req: http.ClientRequest, opts: http.RequestOptions): void }, 'addRequest').mockImplementation(() => undefined);
      const direct = vi.spyOn(config.httpsAgent as https.Agent & { addRequest(req: http.ClientRequest, opts: http.RequestOptions): void }, 'addRequest').mockImplementation(() => undefined);
      const req = config.transport!.request({ protocol: 'https:', hostname: 'fm.example.test', agent: proxyAgent }, () => undefined);
      expect(dispatch).toHaveBeenCalledTimes('pinnedCertSha256' in profile ? 0 : 1);
      expect(direct).toHaveBeenCalledTimes('pinnedCertSha256' in profile ? 1 : 0);
      req.destroy();
      vi.restoreAllMocks();
    }
  });

  it('leaves plain profiles and HTTP URLs on their existing transport', async () => {
    expect(await httpsTransportFor({}, 'https://fm.example.test')).not.toHaveProperty('transport');
    expect(await httpsTransportFor({ allowSelfSigned: true }, 'http://fm.example.test')).not.toHaveProperty('transport');
  });
});
