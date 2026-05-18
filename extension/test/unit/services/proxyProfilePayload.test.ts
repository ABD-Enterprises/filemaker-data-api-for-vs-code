import { describe, expect, it } from 'vitest';

import { buildProxyProfilePayload } from '../../../src/services/proxyClient';
import type { ConnectionProfile } from '../../../src/types/fm';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: 'Prod (do not leak)',
    authMode: 'proxy',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest',
    proxyEndpoint: 'https://proxy.example.com',
    ...overrides
  };
}

describe('buildProxyProfilePayload', () => {
  it('includes the fields the proxy needs to route + auth', () => {
    const payload = buildProxyProfilePayload(profile());
    expect(payload).toEqual({
      id: 'p1',
      database: 'TestDB',
      serverUrl: 'https://fm.example.com',
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    });
  });

  it('omits the human-readable name', () => {
    const payload = buildProxyProfilePayload(profile({ name: 'Prod (do not leak)' }));
    expect('name' in payload).toBe(false);
  });

  it('omits the proxyEndpoint (the proxy already knows its own URL)', () => {
    const payload = buildProxyProfilePayload(profile()) as Record<string, unknown>;
    expect('proxyEndpoint' in payload).toBe(false);
  });

  it('omits the username (proxy auth does not use FM Basic creds)', () => {
    const payload = buildProxyProfilePayload(profile({ username: 'admin' })) as Record<
      string,
      unknown
    >;
    expect('username' in payload).toBe(false);
  });

  it('omits apiBasePath / apiVersionPath when undefined on the profile', () => {
    const payload = buildProxyProfilePayload(
      profile({ apiBasePath: undefined, apiVersionPath: undefined })
    );
    expect('apiBasePath' in payload).toBe(false);
    expect('apiVersionPath' in payload).toBe(false);
  });
});
