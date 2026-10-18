import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { rootCertificates } from 'tls';
import { describe, expect, it } from 'vitest';

import { FMClientError } from '../../src/services/errors';
import { createHttpsAgentForProfile } from '../../src/services/tlsAgent';

describe('createHttpsAgentForProfile', () => {
  it('disables certificate verification when allowSelfSigned is true', () => {
    const agent = createHttpsAgentForProfile({ allowSelfSigned: true });

    expect(agent.options.rejectUnauthorized).toBe(false);
  });

  it('loads a PEM CA bundle when caBundlePath is set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'ca.pem');
    const pem = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n';
    await writeFile(caPath, pem, 'utf8');

    const agent = createHttpsAgentForProfile({ caBundlePath: caPath });

    expect(agent.options.rejectUnauthorized).toBe(true);
    // The file's certificates are added to the default public roots, not substituted for them.
    const ca = agent.options.ca as string[];
    expect(ca[ca.length - 1]).toBe(pem);
    expect(ca.length).toBeGreaterThan(50);
    expect(ca).toEqual(expect.arrayContaining([...rootCertificates.slice(0, 3)]));
  });

  it('notices an edited CA file instead of reusing the agent cached for its path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'ca.pem');
    await writeFile(caPath, '-----BEGIN CERTIFICATE-----\nONE\n-----END CERTIFICATE-----\n', 'utf8');
    const first = createHttpsAgentForProfile({ caBundlePath: caPath });
    expect(createHttpsAgentForProfile({ caBundlePath: caPath })).toBe(first);

    await writeFile(caPath, '-----BEGIN CERTIFICATE-----\nTWO-IS-LONGER\n-----END CERTIFICATE-----\n', 'utf8');
    const second = createHttpsAgentForProfile({ caBundlePath: caPath });
    expect(second).not.toBe(first);
    expect((second.options.ca as string[]).at(-1)).toContain('TWO-IS-LONGER');
  });

  it('loads a CA bundle while disabling verification when both TLS overrides are set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'combined-ca.pem');
    const pem = '-----BEGIN CERTIFICATE-----\nCOMBINED\n-----END CERTIFICATE-----\n';
    await writeFile(caPath, pem, 'utf8');

    const agent = createHttpsAgentForProfile({ allowSelfSigned: true, caBundlePath: caPath });

    expect(agent.options.rejectUnauthorized).toBe(false);
    expect((agent.options.ca as string[]).at(-1)).toBe(pem);
  });

  it('fails closed when the PEM file is missing', () => {
    let caught: FMClientError | undefined;

    try {
      createHttpsAgentForProfile({ caBundlePath: '/definitely/missing/ca.pem' });
    } catch (error) {
      caught = error as FMClientError;
    }

    expect(caught).toBeInstanceOf(FMClientError);
    expect(caught?.code).toBe('TLS_CA_BUNDLE_READ_FAILED');
  });

  it('uses secure verification by default', () => {
    const agent = createHttpsAgentForProfile({});

    expect(agent.options.rejectUnauthorized).toBe(true);
    expect(agent.options.ca).toBeUndefined();
  });
});
