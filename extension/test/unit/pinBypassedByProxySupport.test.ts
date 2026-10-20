import type { AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import {
  httpsTransportFor,
  pinBypassedByHost,
  setAgentReplacedPolicy
} from '../../src/services/tlsAgent';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const PIN = 'a'.repeat(64);

/** What Node reports when the host's own checks reject a server certificate the pin was meant to cover. */
function untrusted(code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'): Error {
  return Object.assign(new Error('unable to verify the first certificate'), {
    code,
    isAxiosError: true
  });
}

function clientFailingWith(error: Error): FMClient {
  const reject = vi.fn().mockRejectedValue(error);
  const http = {
    request: reject,
    post: reject,
    get: reject,
    delete: reject
  } as unknown as AxiosInstance;
  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  void secrets.setPassword('p1', 'the-password');
  return new FMClient(secrets, logger, 3000, http);
}

async function signIn(client: FMClient, extra: Record<string, unknown>): Promise<FMClientError> {
  try {
    await client.createSession({
      id: 'p1',
      name: 'T',
      authMode: 'direct',
      serverUrl: 'https://fms.example.test',
      database: 'Sales',
      username: 'u',
      ...extra
    });
  } catch (caught) {
    return caught as FMClientError;
  }
  throw new Error('expected the sign-in to fail');
}

describe('a pinned certificate when the host replaces the agent (http.proxySupport "override")', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  it('does not stop the request: a server the host trusts anyway works with a stale pin', () => {
    setAgentReplacedPolicy(() => true);
    expect(() =>
      httpsTransportFor(
        { pinnedCertSha256: PIN },
        'https://example.test/fmi/data/vLatest/productInfo'
      )
    ).not.toThrow();
  });

  it('explains itself, with both fixes, when the profile is pinned and the host is replacing the agent', () => {
    setAgentReplacedPolicy(() => true);
    const error = pinBypassedByHost({ pinnedCertSha256: PIN });
    expect(error?.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
    expect(error?.kind).toBe('certificate');
    expect(error?.message).toMatch(/http\.proxySupport/);
    expect(error?.message).toMatch(/"fallback"/);
    expect(error?.message).toMatch(/Forget trusted certificate/);
    expect(error?.message).toMatch(/does not help here/);
  });

  it('has nothing to say without a pin, or when the host honours the agent ("fallback", "off", plain Node)', () => {
    setAgentReplacedPolicy(() => true);
    expect(pinBypassedByHost({})).toBeUndefined();
    expect(pinBypassedByHost({ pinnedCertSha256: 'not-a-fingerprint' })).toBeUndefined();
    setAgentReplacedPolicy(() => false);
    expect(pinBypassedByHost({ pinnedCertSha256: PIN })).toBeUndefined();
  });
});

describe('the explanation through FMClient', () => {
  afterEach(() => setAgentReplacedPolicy(() => false));

  it.each([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN'
  ])('replaces the misleading "not trusted" error (%s) of a pinned profile', async (code) => {
    setAgentReplacedPolicy(() => true);
    const error = await signIn(clientFailingWith(untrusted(code)), { pinnedCertSha256: PIN });
    expect(error.code).toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });

  it("leaves an unpinned profile's certificate error alone", async () => {
    setAgentReplacedPolicy(() => true);
    const error = await signIn(clientFailingWith(untrusted()), {});
    expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });

  it('leaves the error alone when the host honours the agent (the pin itself decided)', async () => {
    setAgentReplacedPolicy(() => false);
    const error = await signIn(clientFailingWith(untrusted()), { pinnedCertSha256: PIN });
    expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });

  it('does not touch a failure that is not about an untrusted certificate', async () => {
    setAgentReplacedPolicy(() => true);
    const error = await signIn(
      clientFailingWith(
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED', isAxiosError: true })
      ),
      { pinnedCertSha256: PIN }
    );
    expect(error.code).not.toBe('PIN_BYPASSED_BY_PROXY_SUPPORT');
  });
});
