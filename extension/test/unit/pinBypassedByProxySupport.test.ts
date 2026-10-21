import type { AxiosInstance } from 'axios';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { reviewAndTrustCertificate } from '../../src/services/certificateTrust';
import * as certificateInspect from '../../src/services/certificateInspect';
import { ProxyClient } from '../../src/services/proxyClient';
import { SecretStore } from '../../src/services/secretStore';
import { hostNetworkingPatched, pinBypassedByHost, setAgentReplacedPolicy } from '../../src/services/tlsAgent';
import { isTrustableCertificateCode } from '../../src/utils/networkErrors';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from './mocks';
import { installVscodeProxyPatch } from '../helpers/vscodeProxyPatch';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const PIN = 'a'.repeat(64);
const legacy = { allowSelfSigned: true, serverUrl: 'https://fms.example.test' };

beforeEach(() => {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) vi.stubEnv(name, undefined);
  vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128');
});
afterEach(() => vi.unstubAllEnvs());
const untrusted = new FMClientError('untrusted', { kind: 'certificate', networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
const OK = {
  response: { productInfo: { name: 'Stub Engine' }, token: 'stub-token' },
  messages: [{ code: '0', message: 'OK' }]
};

/** What Node reports for a certificate failure; `isAxiosError` is how real request failures arrive. */
function certificateFailure(code: string): Error {
  return Object.assign(new Error('certificate problem'), { code, isAxiosError: true });
}

const profile = (extra: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'p1',
  name: 'T',
  authMode: 'direct',
  serverUrl: 'https://fms.example.test',
  database: 'Sales',
  username: 'u',
  ...extra
});

/** An HTTP client whose answer is chosen per request; the sign-in always succeeds unless `signIn` says otherwise. */
function httpWith(handler: (url: string) => unknown): AxiosInstance {
  const request = vi.fn(async (config: { url?: string }) => {
    const out = handler(String(config.url));
    if (out instanceof Error) throw out;
    return { status: 200, headers: {}, data: out };
  });
  return { request } as unknown as AxiosInstance;
}

async function client(http: AxiosInstance): Promise<FMClient> {
  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  await secrets.setPassword('p1', 'the-password');
  return new FMClient(secrets, logger, 3000, http);
}

async function failure(run: () => Promise<unknown>): Promise<FMClientError> {
  try {
    await run();
  } catch (caught) {
    return caught as FMClientError;
  }
  throw new Error('expected a failure');
}

describe('a legacy profile on the environment-proxy route when the host replaces the agent', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  it('leaves successful requests alone (a stubbed client does not open TLS)', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => OK));
    expect((await c.getProductInfo(profile(legacy))).name).toBe('Stub Engine');
  });

  it('offers a fallback only after an untrusted failure on a legacy environment-proxy profile', () => {
    setAgentReplacedPolicy(() => true);
    const error = pinBypassedByHost({ ...legacy }, untrusted);
    expect(error?.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    expect(error?.kind).toBe('certificate');
    expect(error?.message).toMatch(/http\.proxySupport/);
    expect(error?.message).toMatch(/"fallback"/);
    expect(error?.message).toMatch(/Forget trusted certificate/);
    expect(error?.message).toMatch(/does not help here/);
    expect(pinBypassedByHost({ ...legacy })).toBeUndefined();
    expect(pinBypassedByHost({ caBundlePath: '/test.pem', serverUrl: legacy.serverUrl }, untrusted)).toBeUndefined();
    expect(pinBypassedByHost(legacy, untrusted)).toBeDefined();
    expect(pinBypassedByHost({}, untrusted)).toBeUndefined();
    expect(pinBypassedByHost({ pinnedCertSha256: 'not-a-fingerprint' }, untrusted)).toBeUndefined();
    setAgentReplacedPolicy(() => false);
    expect(pinBypassedByHost({ ...legacy }, untrusted)).toBeUndefined();
  });
});

describe('requests that use the new transport do not get the bypass message', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  it.each([{ pinnedCertSha256: PIN }, { allowSelfSigned: true }])('leaves direct %j failures alone even with the host patch active', (tls) => {
    setAgentReplacedPolicy(() => true);
    vi.stubEnv('NO_PROXY', '*');
    expect(pinBypassedByHost({ ...tls, serverUrl: legacy.serverUrl }, untrusted)).toBeUndefined();
  });
});

describe('CA-only failures under the real host patch keep certificate advice and trust actions', () => {
  let dir: string;
  let caBundlePath: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wrong-ca-'));
    caBundlePath = join(dir, 'ca.pem');
    await writeFile(caBundlePath, makeCertificate({ subjectCn: 'Unrelated CA', subjectKey: newKeyPair(), isCa: true, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY) }).pem);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it.each(['override', 'fallback', 'on', 'off'] as const)('%s: wrong-CA errors are untrusted-chain errors on both direct and environment-proxy routes', async (mode) => {
    nock.restore();
    const restore = installVscodeProxyPatch(mode);
    setAgentReplacedPolicy(hostNetworkingPatched);
    const inspect = vi.spyOn(certificateInspect, 'inspectServerCertificate').mockRejectedValue(new Error('no certificate inspection in this socket-free test'));
    try {
      expect(hostNetworkingPatched()).toBe(true);
      for (const noProxy of ['*', '']) {
        vi.stubEnv('NO_PROXY', noProxy);
        const c = await client(httpWith(() => certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')));
        const error = await failure(() => c.createSession(profile({ caBundlePath })));
        expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
        expect(error.networkCode).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
        expect(isTrustableCertificateCode(error.networkCode)).toBe(true);
        expect(error.message).toMatch(/not trusted.*missing intermediate/s);
        expect(error.message).not.toMatch(/could not be applied|http\.proxySupport|fallback/);
      }
    } finally {
      inspect.mockRestore();
      setAgentReplacedPolicy(() => false);
      restore();
      nock.activate();
    }
  });
});

describe('which failures are explained', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  // Only untrusted-chain errors use the backup remedy; pin/date/name refusals keep their own explanation.
  it.each([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
  ])('replaces the generic error for %s on a legacy environment-proxy profile', async (code) => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => certificateFailure(code)));
    const error = await failure(() => c.createSession(profile(legacy)));
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    // Keep the original certificate code so trust actions remain available.
    expect(error.networkCode).toBe(code);
  });

  it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'CERT_REVOKED', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
    'leaves %s alone',
    async (code) => {
      setAgentReplacedPolicy(() => true);
      const c = await client(httpWith(() => certificateFailure(code)));
      const error = await failure(() => c.createSession(profile(legacy)));
      expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    }
  );

  it("leaves the pin's own refusal alone (it means the agent did run)", async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => certificateFailure('FM_CERT_PIN_MISMATCH')));
    const error = await failure(() => c.createSession(profile(legacy)));
    expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });

  it("leaves an unpinned profile's error alone, and so when the host honours the agent", async () => {
    setAgentReplacedPolicy(() => true);
    const unpinned = await client(
      httpWith(() => certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))
    );
    expect((await failure(() => unpinned.createSession(profile()))).code).not.toBe(
      'PIN_BYPASSED_BY_PROXY_SUPPORT'
    );
    setAgentReplacedPolicy(() => false);
    const honoured = await client(
      httpWith(() => certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))
    );
    expect(
      (await failure(() => honoured.createSession(profile(legacy)))).code
    ).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });
});

describe('every route that can meet the failure explains it', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));
  const proxiedLegacy = profile(legacy);

  it('server-level requests (product info before sign-in)', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')));
    expect((await failure(() => c.getProductInfo(proxiedLegacy))).code).toBe(
      'PIN_BYPASSED_BY_PROXY_SUPPORT'
    );
  });

  it('signed-in requests, where the failure comes after a session already exists', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(
      httpWith((url) => (url.endsWith('/sessions') ? OK : certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')))
    );
    const error = await failure(() => c.listLayouts(proxiedLegacy));
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    expect(error.endpoint).toBeTruthy(); // the request's own details are kept for the history and the report
  });

  it('proxy connections with legacy certificate settings', async () => {
    setAgentReplacedPolicy(() => true);
    const post = vi.fn().mockRejectedValue(certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setProxyApiKey('p1', 'key');
    const proxy = new ProxyClient(secrets, logger, 3000, { post } as unknown as AxiosInstance);
    const error = await failure(() =>
      proxy.createSession(
        profile({
          authMode: 'proxy',
          proxyEndpoint: 'https://proxy.example.test/api',
          allowSelfSigned: true
        })
      )
    );
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });
});

describe('routes and hosts that need their own check', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  it('script runs', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(
      httpWith((url) =>
        url.endsWith('/sessions') ? OK : certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
      )
    );
    const error = await failure(() =>
      c.runScript(profile(legacy), { layout: 'L', scriptName: 'S' } as never)
    );
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });

  it.each([
    'https://localhost:4443',
    'https://127.0.0.1:4443'
  ])(
    'leaves a loopback address alone (%s): the host does not replace the agent there, so the pin did run',
    async (serverUrl) => {
      setAgentReplacedPolicy(() => true);
      // These two exact hosts keep the supplied agent even in the host request patch.
      const c = await client(httpWith(() => certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')));
      const error = await failure(() =>
        c.createSession(profile({ serverUrl, allowSelfSigned: true }))
      );
      expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    }
  );

  it.each(['https://192.168.1.50:443', 'https://[::1]:4443', 'https://dev.localhost', 'https://127.0.0.2'])('still explains %s, which the host does replace', async (serverUrl) => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')));
    const error = await failure(() =>
      c.createSession(profile({ serverUrl, allowSelfSigned: true }))
    );
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    expect(error.message).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE/); // the specific cause is kept in the text
  });

  it('judges a proxy profile by its proxy address', async () => {
    setAgentReplacedPolicy(() => true);
    expect(
      pinBypassedByHost({
        allowSelfSigned: true,
        authMode: 'proxy',
        serverUrl: 'https://fms.example.test',
        proxyEndpoint: 'https://localhost:9000/api'
      }, untrusted)
    ).toBeUndefined();
    expect(
      pinBypassedByHost({
        allowSelfSigned: true,
        authMode: 'proxy',
        serverUrl: 'https://localhost',
        proxyEndpoint: 'https://proxy.example.test/api'
      }, untrusted)
    ).toBeDefined();
  });

  it('an unpinned proxy profile is left alone', async () => {
    setAgentReplacedPolicy(() => true);
    const post = vi.fn().mockRejectedValue(certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setProxyApiKey('p1', 'key');
    const proxy = new ProxyClient(secrets, logger, 3000, { post } as unknown as AxiosInstance);
    const error = await failure(() =>
      proxy.createSession(
        profile({ authMode: 'proxy', proxyEndpoint: 'https://proxy.example.test/api' })
      )
    );
    expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });
});

describe('the metadata route', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  it('explains the legacy environment-proxy failure for layout metadata', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(
      httpWith((url) =>
        url.endsWith('/sessions') ? OK : certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
      )
    );
    const error = await failure(() =>
      c.getLayoutMetadata(profile(legacy), 'Sales')
    );
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });
});

describe('the trust dialog tells the truth about what trusting will do', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));
  const info = {
    host: 'fms.example.test',
    port: '443',
    subject: 'CN=x',
    issuer: 'CN=y',
    altNames: [],
    validFrom: 'a',
    validTo: 'b',
    sha256: 'b'.repeat(64),
    expired: false,
    notYetValid: false,
    selfSigned: true
  };
  async function detailFor(serverUrl: string): Promise<string> {
    let detail = '';
    await reviewAndTrustCertificate(
      { name: 'T', authMode: 'direct', serverUrl },
      {},
      {
        inspect: async () => ({ ...info }),
        confirm: async (_message, text) => {
          detail = text;
          return undefined;
        }
      }
    );
    return detail;
  }

  it('promises enforcement only where it can be enforced', async () => {
    setAgentReplacedPolicy(() => false);
    expect(await detailFor('https://fms.example.test')).toMatch(/warn you if it ever changes/);
  });

  it('promises certificate enforcement under override without asking for a setting change', async () => {
    setAgentReplacedPolicy(() => true);
    const text = await detailFor('https://fms.example.test');
    expect(text).not.toMatch(/http\.proxySupport/);
    expect(text).toMatch(/warn you if it ever changes/);
  });

  it('keeps the promise for a loopback address, where the host leaves the connection alone', async () => {
    setAgentReplacedPolicy(() => true);
    expect(await detailFor('https://localhost:8443')).toMatch(/warn you if it ever changes/);
  });
});

describe("the dialog learns VS Code's setting by itself, before any request has been made", () => {
  const info = {
    host: 'fms.example.test',
    port: '443',
    subject: 'CN=x',
    issuer: 'CN=y',
    altNames: [],
    validFrom: 'a',
    validTo: 'b',
    sha256: 'c'.repeat(64),
    expired: false,
    notYetValid: false,
    selfSigned: true
  };
  // A fresh module state each time: nothing has installed a policy, as when "Review server certificate" is the first thing used.
  it.each([
    ['override', false],
    [undefined, false],
    ['fallback', false],
    ['off', false],
    ['on', false]
  ])('http.proxySupport = %s: trust cannot take effect = %s', async (setting, cannotTakeEffect) => {
    vi.resetModules();
    const vscode = await import('vscode');
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((() => ({
      get: (key: string, fallback?: unknown) =>
        key === 'proxySupport' && setting !== undefined ? setting : fallback
    })) as never);
    const { reviewAndTrustCertificate } = await import('../../src/services/certificateTrust');
    let detail = '';
    await reviewAndTrustCertificate(
      { name: 'T', authMode: 'direct', serverUrl: 'https://fms.example.test' },
      {},
      {
        inspect: async () => ({ ...info }),
        confirm: async (_message, text) => {
          detail = text;
          return undefined;
        }
      }
    );
    expect(detail.includes('warn you if it ever changes')).toBe(!cannotTakeEffect);
    expect(/http\.proxySupport/.test(detail)).toBe(cannotTakeEffect);
  });
});
