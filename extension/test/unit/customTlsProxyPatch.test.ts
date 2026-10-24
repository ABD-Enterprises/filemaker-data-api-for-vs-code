import type http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import nock from 'nock';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { proxySupportReplacesAgent } from '../../src/services/proxySupport';
import { FMClientError } from '../../src/services/errors';
import { pinBypassedByHost, setAgentReplacedPolicy, httpsTransportFor, PinnedCertificateAgent } from '../../src/services/tlsAgent';
import { normalizeError } from '../../src/utils/normalizeError';
import { installVscodeProxyPatch } from '../helpers/vscodeProxyPatch';

type DispatchAgent = https.Agent & { addRequest(req: http.ClientRequest, options: http.RequestOptions): void };
let restore: (() => void) | undefined;
beforeEach(() => nock.restore());
afterEach(() => { setAgentReplacedPolicy(() => false); restore?.(); restore = undefined; vi.restoreAllMocks(); nock.activate(); });

const profile = { pinnedCertSha256: 'a'.repeat(64) };
const url = 'https://192.0.2.1/fmi/data/vLatest/databases/Quality/sessions';

describe('the real VS Code patch, without sockets', () => {
  it('does not report a patch in plain Node and detects one installed after loading', async () => {
    vi.resetModules();
    const { hostNetworkingPatched } = await import('../../src/services/tlsAgent');
    expect(hostNetworkingPatched()).toBe(false);
    restore = installVscodeProxyPatch('override');
    expect(hostNetworkingPatched()).toBe(true);
  });

  it('fails closed if a future host patch no longer exposes its proxy resolver', async () => {
    restore = installVscodeProxyPatch('override');
    const probe = Object.assign(new EventEmitter(), { agent: { destroy: vi.fn() }, destroy: vi.fn() });
    vi.spyOn(https, 'request').mockReturnValue(probe as never);
    const config = httpsTransportFor(profile, url);
    const dispatched = vi.spyOn(config.httpsAgent as DispatchAgent, 'addRequest').mockImplementation(() => undefined);
    const error = await axios.post(url, { password: 'never-sent' }, { ...config, maxRedirects: 0, timeout: 500 }).catch((e: unknown) => e);
    expect(normalizeError(error).networkCode).toBe('PIN_THROUGH_PROXY');
    expect(dispatched).not.toHaveBeenCalled();
    expect(https.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'HEAD' }));
    const options = vi.mocked(https.request).mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('headers');
    expect(options).not.toHaveProperty('auth');
    expect(probe.destroy).toHaveBeenCalled();
  });

  it('detects the actual host patch for the fallback message rather than inferring it from a setting', () => {
    // Start with an unmodified https.request; ignore nock's separately restored ClientRequest.
    restore = installVscodeProxyPatch('override');
    expect(proxySupportReplacesAgent()).toBe(true);
    setAgentReplacedPolicy(proxySupportReplacesAgent);
    const failure = new FMClientError('untrusted', { kind: 'certificate', networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    expect(pinBypassedByHost({ ...profile, serverUrl: url }, failure)).toBeUndefined();
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128');
    try {
      expect(pinBypassedByHost({ allowSelfSigned: true, serverUrl: url }, failure)).toMatchObject({ code: 'PIN_BYPASSED_BY_PROXY_SUPPORT', networkCode: failure.networkCode });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(pinBypassedByHost({ ...profile, serverUrl: url })).toBeUndefined();
  });

  it.each(['override', 'fallback', 'on', 'off'] as const)('%s hands the request to the cached pin agent on a direct route', async (mode) => {
    restore = installVscodeProxyPatch(mode);
    const config = httpsTransportFor(profile, url);
    const dispatched = vi.spyOn(config.httpsAgent as DispatchAgent, 'addRequest').mockImplementation(() => undefined);
    const dial = vi.spyOn(https.Agent.prototype, 'createConnection').mockImplementation(() => { throw new Error('no probe may dial'); });
    const req = config.transport!.request({ hostname: '192.0.2.1', path: '/', protocol: 'https:' }, () => undefined);
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    expect(dial).not.toHaveBeenCalled();
    expect((req as http.ClientRequest & { agent: https.Agent }).agent).toBe(config.httpsAgent);
    req.destroy();
  });

  it.each([
    ['override', 'http://proxy.example.test:3128'],
    ['fallback', 'http://proxy.example.test:3128'],
    ['override', 'https://proxy.example.test:443'],
    ['fallback', 'https://proxy.example.test:443']
  ] as const)('%s refuses a VS Code http.proxy %s route before any socket opens', async (mode, proxy) => {
    restore = installVscodeProxyPatch(mode, { proxy });
    const dial = vi.spyOn(https.Agent.prototype, 'createConnection').mockImplementation(() => { throw new Error('must not dial'); });
    const config = httpsTransportFor(profile, url);
    const request = axios.post(url, { password: 'never-sent' }, { ...config, maxRedirects: 0, timeout: 500 });
    const error = await request.catch((e: unknown) => e);
    expect(normalizeError(error)).toMatchObject({ kind: 'certificate', networkCode: 'PIN_THROUGH_PROXY', isRetryable: false });
    expect(normalizeError(error).message).toMatch(/system\/PAC proxy/);
    expect(dial).not.toHaveBeenCalled();
  });

  it('refuses a PAC/system proxy and does not dispatch the credential-bearing request', async () => {
    const resolveProxy = vi.fn(async () => 'PROXY proxy.example.test:3128');
    restore = installVscodeProxyPatch('override', { resolveProxy });
    const config = httpsTransportFor(profile, url);
    const dispatched = vi.spyOn(config.httpsAgent as DispatchAgent, 'addRequest').mockImplementation(() => undefined);
    const error = await axios.post(url, { password: 'never-sent' }, { ...config, maxRedirects: 0, timeout: 500 }).catch((e: unknown) => e);
    expect(normalizeError(error).networkCode).toBe('PIN_THROUGH_PROXY');
    expect(resolveProxy).toHaveBeenCalledWith(url);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it('enforces streamed upload limits while the system proxy lookup is still pending', async () => {
    restore = installVscodeProxyPatch('override', { resolveProxy: () => new Promise(() => undefined) });
    const config = httpsTransportFor(profile, url);
    const dispatched = vi.spyOn(config.httpsAgent as DispatchAgent, 'addRequest').mockImplementation(() => undefined);
    const { Readable } = await import('stream');
    await expect(axios.post(url, Readable.from(['too large']), { ...config, maxRedirects: 0, timeout: 500, maxBodyLength: 3 })).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' });
    expect(dispatched).not.toHaveBeenCalled();
  });

  it.each(['abort', 'timeout'] as const)('covers a pending system lookup with axios %s and never dispatches later', async (action) => {
    let finish!: (value: string) => void;
    restore = installVscodeProxyPatch('override', { resolveProxy: () => new Promise((resolve) => { finish = resolve; }) });
    const config = httpsTransportFor(profile, url);
    const dispatched = vi.spyOn(config.httpsAgent as DispatchAgent, 'addRequest').mockImplementation(() => undefined);
    const control = new AbortController();
    const request = axios.post(url, {}, { ...config, maxRedirects: 0, timeout: 30, signal: control.signal }).catch((e: { code: string }) => e);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (action === 'abort') control.abort();
    expect(await request).toMatchObject({ code: action === 'abort' ? 'ERR_CANCELED' : 'ECONNABORTED' });
    finish('DIRECT');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dispatched).not.toHaveBeenCalled();
  });
});

it('a wrong pin destroys the TLS socket before releasing any buffered request bytes', () => {
  const socket = Object.assign(new EventEmitter(), {
    cork: vi.fn(), uncork: vi.fn(), destroy: vi.fn(),
    isSessionReused: () => false,
    getPeerCertificate: () => ({ fingerprint256: 'b'.repeat(64) })
  });
  vi.spyOn(https.Agent.prototype, 'createConnection').mockReturnValue(socket as never);
  const agent = new PinnedCertificateAgent({}, { sha256: 'a'.repeat(64), allowExpired: false });
  agent.createConnection({});
  socket.emit('secureConnect');
  expect(socket.destroy).toHaveBeenCalledWith(expect.objectContaining({ code: 'FM_CERT_PIN_MISMATCH' }));
  expect(socket.uncork).not.toHaveBeenCalled();
});
