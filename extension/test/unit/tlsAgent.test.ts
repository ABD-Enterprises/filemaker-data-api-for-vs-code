import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { rootCertificates } from 'tls';
import { describe, expect, it } from 'vitest';

import { FMClientError } from '../../src/services/errors';
import { createHttpsAgentForProfile } from '../../src/services/tlsAgent';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';

const realPem = (cn: string): string =>
  makeCertificate({ subjectCn: cn, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: newKeyPair() }).pem;

describe('createHttpsAgentForProfile', () => {
  it('disables certificate verification when allowSelfSigned is true', () => {
    const agent = createHttpsAgentForProfile({ allowSelfSigned: true });

    expect(agent.options.rejectUnauthorized).toBe(false);
  });

  it('loads a PEM CA bundle when caBundlePath is set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'ca.pem');
    const pem = realPem('test');
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
    await writeFile(caPath, realPem('one'), 'utf8');
    const first = createHttpsAgentForProfile({ caBundlePath: caPath });
    expect(createHttpsAgentForProfile({ caBundlePath: caPath })).toBe(first);

    const longer = `${realPem('two-is-longer')}${realPem('and-another')}`;
    await writeFile(caPath, longer, 'utf8');
    const second = createHttpsAgentForProfile({ caBundlePath: caPath });
    expect(second).not.toBe(first);
    expect((second.options.ca as string[]).at(-1)).toBe(longer);
  });

  it('loads a CA bundle while disabling verification when both TLS overrides are set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'combined-ca.pem');
    const pem = realPem('combined');
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

  it('says a CA file without a certificate is not a certificate file (instead of a misleading verify error)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const notPem = join(root, 'notes.pem');
    await writeFile(notPem, 'this is not a certificate', 'utf8');
    const broken = join(root, 'broken.pem');
    await writeFile(broken, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n', 'utf8');

    for (const file of [notPem, broken]) {
      let caught: FMClientError | undefined;
      try {
        createHttpsAgentForProfile({ caBundlePath: file });
      } catch (error) {
        caught = error as FMClientError;
      }
      expect(caught?.code).toBe('TLS_CA_BUNDLE_INVALID');
      expect(caught?.message).toMatch(/does not contain a certificate/);
    }
  });

  it('adds the operating system\'s certificates to the defaults only when the policy says so and Node can read them', async () => {
    const { setSystemCertificatePolicy } = await import('../../src/services/tlsAgent');
    const canRead = typeof (await import('tls')).getCACertificates === 'function';
    try {
      setSystemCertificatePolicy(() => false);
      expect(createHttpsAgentForProfile({}).options.ca).toBeUndefined();

      setSystemCertificatePolicy(() => true);
      const agent = createHttpsAgentForProfile({});
      if (canRead) {
        expect((agent.options.ca as string[]).length).toBeGreaterThanOrEqual(rootCertificates.length);
        expect(agent.options.rejectUnauthorized).toBe(true);
      } else {
        expect(agent.options.ca).toBeUndefined(); // older Node: defaults unchanged
      }
    } finally {
      setSystemCertificatePolicy(() => false);
    }
  });
});
