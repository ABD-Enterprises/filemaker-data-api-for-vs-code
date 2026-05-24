import { describe, expect, it } from 'vitest';

import { resolveHeadlessBridgeConfig } from '../../src/headlessBridge';

describe('headless bridge config', () => {
  it('reads required env configuration and defaults the bridge port', () => {
    const config = resolveHeadlessBridgeConfig({
      FM_SERVER: 'https://fm.example.com/',
      FM_DATABASE: 'Operations',
      FM_USER: 'automation',
      FM_PASS_FILE: '/run/secrets/fm-password'
    });

    expect(config).toEqual({
      port: 8080,
      serverUrl: 'https://fm.example.com',
      database: 'Operations',
      username: 'automation',
      passwordFile: '/run/secrets/fm-password',
      bridgeToken: undefined
    });
  });

  it('rejects invalid bridge ports', () => {
    expect(() =>
      resolveHeadlessBridgeConfig({
        BRIDGE_PORT: '99999',
        FM_SERVER: 'https://fm.example.com',
        FM_DATABASE: 'Operations',
        FM_USER: 'automation',
        FM_PASS_FILE: '/run/secrets/fm-password'
      })
    ).toThrow('BRIDGE_PORT');
  });

  it('requires FileMaker connection settings', () => {
    expect(() => resolveHeadlessBridgeConfig({})).toThrow('FM_SERVER is required');
  });
});
