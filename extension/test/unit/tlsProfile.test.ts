import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeTlsSettings, validateCaBundleFile } from '../../src/utils/tlsProfile';

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpegPjMCMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnRl\n-----END CERTIFICATE-----\n';

describe('validateCaBundleFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ca-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts an absolute path to a PEM certificate file and trims it', async () => {
    const file = path.join(dir, 'ca.pem');
    await writeFile(file, CERT);
    expect(await validateCaBundleFile(`  ${file}  `)).toEqual({ ok: true, value: file });
  });

  it('refuses empty, relative, missing, directory, non-PEM, oversize and private-key files', async () => {
    const notPem = path.join(dir, 'notes.txt');
    await writeFile(notPem, 'hello');
    const key = path.join(dir, 'key.pem');
    await writeFile(key, `${CERT}-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n`);
    const big = path.join(dir, 'big.pem');
    await writeFile(big, CERT + 'x'.repeat(1024 * 1024));

    for (const bad of ['', '   ', 'relative/ca.pem', path.join(dir, 'missing.pem'), dir, notPem, big]) {
      expect((await validateCaBundleFile(bad)).ok, bad).toBe(false);
    }
    const withKey = await validateCaBundleFile(key);
    expect(withKey.ok).toBe(false);
    expect(withKey.error).toMatch(/private key/);
  });
});

describe('describeTlsSettings', () => {
  it('says nothing for a normal profile and names both options when set', () => {
    expect(describeTlsSettings({})).toBeUndefined();
    expect(describeTlsSettings({ allowSelfSigned: true })).toMatch(/insecure/);
    expect(describeTlsSettings({ caBundlePath: '/x.pem' })).toBe('custom CA');
    expect(describeTlsSettings({ allowSelfSigned: true, caBundlePath: '/x.pem' })).toMatch(/insecure.*custom CA/);
  });
});
