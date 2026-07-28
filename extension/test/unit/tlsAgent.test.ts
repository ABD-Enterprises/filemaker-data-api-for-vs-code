import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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
    expect(agent.options.ca).toBe(pem);
  });

  it('loads a CA bundle while disabling verification when both TLS overrides are set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'combined-ca.pem');
    const pem = '-----BEGIN CERTIFICATE-----\nCOMBINED\n-----END CERTIFICATE-----\n';
    await writeFile(caPath, pem, 'utf8');

    const agent = createHttpsAgentForProfile({ allowSelfSigned: true, caBundlePath: caPath });

    expect(agent.options.rejectUnauthorized).toBe(false);
    expect(agent.options.ca).toBe(pem);
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
