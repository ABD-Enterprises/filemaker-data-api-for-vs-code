import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environmentProxyFor } from '../../src/services/tlsAgent';

// axios decides on a proxy with `proxy-from-env` and then its own NO_PROXY matcher. A pinned
// certificate is refused only when axios WOULD use a proxy, and checked directly (never through one)
// only when it would not, so this must agree with the real thing on every input.
let realGetProxyForUrl: (url: string) => string;
let realShouldBypass: (url: string) => boolean;

const NAMES = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy', 'npm_config_https_proxy', 'npm_config_proxy'
];

const urls = [
  'https://fm.example.com:16000/fmi/data',
  'https://fms.corp.com/x',
  'https://corp.com/x',
  'https://localhost:8443/x',
  'https://127.0.0.1:8443/x',
  'https://10.1.2.3/x',
  'https://[::1]:8443/x',
  'http://fm.example.com/x'
];

const environments: Array<Record<string, string>> = [
  {},
  { HTTPS_PROXY: 'http://proxy:3128' },
  { HTTPS_PROXY: 'https://proxy:443' },
  { https_proxy: 'proxy:3128' },
  { ALL_PROXY: 'http://proxy:1080' },
  { all_proxy: 'http://proxy:1080' },
  { HTTP_PROXY: 'http://proxy:3128' },
  { npm_config_https_proxy: 'http://proxy:3128' },
  { npm_config_proxy: 'http://proxy:3128' },
  ...[
    '*', 'corp.com', '.corp.com', '*.corp.com', 'fms.corp.com', 'fms.corp.com:443', 'fms.corp.com:444',
    'fm.example.com:16000', 'fm.example.com:443', 'localhost', '127.0.0.1', '10.0.0.0/8', '10.1.2.3',
    '::1', '[::1]', 'example.com', '.example.com', 'other.net, corp.com', 'LOCALHOST'
  ].flatMap((noProxy): Array<Record<string, string>> => [
    { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: noProxy },
    { https_proxy: 'http://proxy:3128', no_proxy: noProxy }
  ])
];

describe('environmentProxyFor agrees with axios about when a proxy applies', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const name of NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    const proxyFromEnv = (await import(/* @vite-ignore */ ['proxy', 'from', 'env'].join('-'))) as { getProxyForUrl: (url: string) => string };
    const bypass = (await import(/* @vite-ignore */ ['axios', 'unsafe', 'helpers', 'shouldBypassProxy.js'].join('/'))) as { default: (url: string) => boolean };
    realGetProxyForUrl = proxyFromEnv.getProxyForUrl;
    realShouldBypass = bypass.default;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('gives the same yes/no on a corpus of addresses and environments', () => {
    const disagreements: string[] = [];
    for (const env of environments) {
      for (const name of NAMES) delete process.env[name];
      Object.assign(process.env, env);
      for (const url of urls) {
        const axiosUses = Boolean(realGetProxyForUrl(url)) && !realShouldBypass(url);
        const ours = Boolean(environmentProxyFor(url));
        if (axiosUses !== ours) {
          disagreements.push(`${JSON.stringify(env)} ${url}: axios=${axiosUses} ours=${ours}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('does not treat npm_config_* variables or HTTP_PROXY as a proxy for an https address (axios ignores them)', () => {
    process.env.npm_config_https_proxy = 'http://proxy:3128';
    process.env.npm_config_proxy = 'http://proxy:3128';
    process.env.HTTP_PROXY = 'http://proxy:3128';
    expect(environmentProxyFor('https://fm.example.com')).toBeUndefined();
  });

  it('a NO_PROXY of "corp.com" does not cover fms.corp.com (axios proxies it), but ".corp.com" does', () => {
    process.env.HTTPS_PROXY = 'http://proxy:3128';
    process.env.NO_PROXY = 'corp.com';
    expect(environmentProxyFor('https://fms.corp.com')).toBe('http://proxy:3128');
    process.env.NO_PROXY = '.corp.com';
    expect(environmentProxyFor('https://fms.corp.com')).toBeUndefined();
  });

  it('actually sees the corpus: at least one environment says "proxy" and one says "no proxy"', () => {
    process.env.HTTPS_PROXY = 'http://proxy:3128';
    expect(environmentProxyFor('https://fm.example.com')).toBeTruthy();
    process.env.NO_PROXY = '*';
    expect(environmentProxyFor('https://fm.example.com')).toBeUndefined();
  });
});
