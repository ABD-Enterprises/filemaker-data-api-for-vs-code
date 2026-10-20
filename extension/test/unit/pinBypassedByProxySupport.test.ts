import type { AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { reviewAndTrustCertificate } from '../../src/services/certificateTrust';
import { ProxyClient } from '../../src/services/proxyClient';
import { SecretStore } from '../../src/services/secretStore';
import { pinBypassedByHost, setAgentReplacedPolicy } from '../../src/services/tlsAgent';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const PIN = 'a'.repeat(64);
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

describe('a pinned certificate when the host replaces the agent (http.proxySupport "override")', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  it('does not stop the request: a server the host trusts anyway works with a stale pin', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => OK));
    expect((await c.getProductInfo(profile({ pinnedCertSha256: PIN }))).name).toBe('Stub Engine');
  });

  it('explains itself, with both fixes, and is quiet without a pin or when the host honours the agent', () => {
    setAgentReplacedPolicy(() => true);
    const error = pinBypassedByHost({ pinnedCertSha256: PIN });
    expect(error?.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    expect(error?.kind).toBe('certificate');
    expect(error?.message).toMatch(/http\.proxySupport/);
    expect(error?.message).toMatch(/"fallback"/);
    expect(error?.message).toMatch(/Forget trusted certificate/);
    expect(error?.message).toMatch(/does not help here/);
    expect(pinBypassedByHost({})).toBeUndefined();
    expect(pinBypassedByHost({ pinnedCertSha256: 'not-a-fingerprint' })).toBeUndefined();
    setAgentReplacedPolicy(() => false);
    expect(pinBypassedByHost({ pinnedCertSha256: PIN })).toBeUndefined();
  });
});

describe('which failures are explained', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  // Everything a pin would have covered: not trusted, wrong host name, outside its dates.
  it.each([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID'
  ])('replaces the generic error for %s on a pinned profile', async (code) => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => certificateFailure(code)));
    const error = await failure(() => c.createSession(profile({ pinnedCertSha256: PIN })));
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    // No network code, so no "Trust this certificate" button is offered for a decision that cannot take effect.
    expect(error.networkCode).toBeUndefined();
  });

  it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'CERT_REVOKED'])(
    'leaves %s alone',
    async (code) => {
      setAgentReplacedPolicy(() => true);
      const c = await client(httpWith(() => certificateFailure(code)));
      const error = await failure(() => c.createSession(profile({ pinnedCertSha256: PIN })));
      expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    }
  );

  it("leaves the pin's own refusal alone (it means the agent did run)", async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => certificateFailure('FM_CERT_PIN_MISMATCH')));
    const error = await failure(() => c.createSession(profile({ pinnedCertSha256: PIN })));
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
      (await failure(() => honoured.createSession(profile({ pinnedCertSha256: PIN })))).code
    ).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });
});

describe('every route that can meet the failure explains it', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));
  const pinned = profile({ pinnedCertSha256: PIN });

  it('server-level requests (product info before sign-in)', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')));
    expect((await failure(() => c.getProductInfo(pinned))).code).toBe(
      'PIN_BYPASSED_BY_PROXY_SUPPORT'
    );
  });

  it('signed-in requests, where the failure comes after a session already exists', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(
      httpWith((url) => (url.endsWith('/sessions') ? OK : certificateFailure('CERT_HAS_EXPIRED')))
    );
    const error = await failure(() => c.listLayouts(pinned));
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    expect(error.endpoint).toBeTruthy(); // the request's own details are kept for the history and the report
  });

  it('proxy connections, which can be pinned too', async () => {
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
          pinnedCertSha256: PIN
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
      c.runScript(profile({ pinnedCertSha256: PIN }), { layout: 'L', scriptName: 'S' } as never)
    );
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });

  it.each([
    'https://localhost:4443',
    'https://127.0.0.1:4443',
    'https://[::1]:4443',
    'https://dev.localhost'
  ])(
    'leaves a loopback address alone (%s): the host does not replace the agent there, so the pin did run',
    async (serverUrl) => {
      setAgentReplacedPolicy(() => true);
      // The pin's own "not yet valid" refusal shares its code with the TLS one and must not be mislabelled.
      const c = await client(httpWith(() => certificateFailure('CERT_NOT_YET_VALID')));
      const error = await failure(() =>
        c.createSession(profile({ serverUrl, pinnedCertSha256: PIN }))
      );
      expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    }
  );

  it('still explains a LAN address, which the host does replace', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(httpWith(() => certificateFailure('CERT_NOT_YET_VALID')));
    const error = await failure(() =>
      c.createSession(profile({ serverUrl: 'https://192.168.1.50:443', pinnedCertSha256: PIN }))
    );
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    expect(error.message).toMatch(/CERT_NOT_YET_VALID/); // the specific cause is kept in the text
  });

  it('judges a proxy profile by its proxy address', async () => {
    setAgentReplacedPolicy(() => true);
    expect(
      pinBypassedByHost({
        pinnedCertSha256: PIN,
        authMode: 'proxy',
        serverUrl: 'https://fms.example.test',
        proxyEndpoint: 'https://localhost:9000/api'
      })
    ).toBeUndefined();
    expect(
      pinBypassedByHost({
        pinnedCertSha256: PIN,
        authMode: 'proxy',
        serverUrl: 'https://localhost',
        proxyEndpoint: 'https://proxy.example.test/api'
      })
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

  it('explains the failure for layout metadata, which uses the raw signed-in route', async () => {
    setAgentReplacedPolicy(() => true);
    const c = await client(
      httpWith((url) =>
        url.endsWith('/sessions') ? OK : certificateFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
      )
    );
    const error = await failure(() =>
      c.getLayoutMetadata(profile({ pinnedCertSha256: PIN }), 'Sales')
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

  it('says the trust cannot take effect while VS Code replaces the connection, and names the setting', async () => {
    setAgentReplacedPolicy(() => true);
    const text = await detailFor('https://fms.example.test');
    expect(text).toMatch(/http\.proxySupport/);
    expect(text).toMatch(/"fallback"/);
    expect(text).not.toMatch(/warn you if it ever changes/);
  });

  it('keeps the promise for a loopback address, where the host leaves the connection alone', async () => {
    setAgentReplacedPolicy(() => true);
    expect(await detailFor('https://localhost:8443')).toMatch(/warn you if it ever changes/);
  });
});
