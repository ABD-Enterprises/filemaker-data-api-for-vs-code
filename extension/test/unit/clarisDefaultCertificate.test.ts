import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { inspectServerCertificate, reviewAndTrustCertificate, withPinnedCertificate } from '../../src/services/certificateTrust';
import type { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { normalizeSha256 } from '../../src/services/tlsAgent';
import type { ConnectionProfile } from '../../src/types/fm';
import { startTlsServer, type TestTlsServer } from '../helpers/tlsServer';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const PLAIN =
  "This server uses a certificate that is not trusted (FileMaker Server's default certificate is self-signed). You can trust this certificate in the wizard, or install a certificate from a public authority on the server.";

/**
 * FileMaker Server's default certificate, as seen in the field: the leaf is "Claris Self Signed
 * Certificate (Not for Production Use)", with no subject alternative names, issued by the private
 * "Claris Root Authority"; only the leaf is sent, and the server speaks TLS 1.2.
 */
function clarisDefault() {
  const rootKey = newKeyPair();
  const leafKey = newKeyPair();
  const now = Date.now();
  const leaf = makeCertificate({
    subjectCn: 'Claris Self Signed Certificate (Not for Production Use)',
    notBefore: new Date(now - 30 * DAY),
    notAfter: new Date(now + 365 * DAY),
    subjectKey: leafKey,
    issuer: { cn: 'Claris Root Authority', key: rootKey }
  });
  return { leafKey, leaf };
}

describe("FileMaker Server's default certificate", () => {
  const servers: TestTlsServer[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function serve() {
    const material = clarisDefault();
    const server = await startTlsServer({ key: material.leafKey, chain: [material.leaf], maxVersion: 'TLSv1.2' });
    servers.push(server);
    return { server, ...material };
  }

  async function login(server: TestTlsServer, extra: Partial<ConnectionProfile> = {}): Promise<string | FMClientError> {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'the-password');
    try {
      return await new FMClient(secrets, logger, 3000).createSession({
        id: 'p1', name: 'Claris', authMode: 'direct', serverUrl: `https://localhost:${server.port}`, database: 'Sales', username: 'u', ...extra
      });
    } catch (error) {
      return error as FMClientError;
    }
  }

  it('is refused with the plain-words message, and no credentials are sent', async () => {
    const { server } = await serve();
    const error = (await login(server)) as FMClientError;
    expect(error.networkCode).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(error.kind).toBe('certificate');
    expect(error.message.startsWith(PLAIN)).toBe(true);
    expect(error.isRetryable).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('can be pinned: the missing host name and the private issuer are skipped for that leaf only, and the sign-in works', async () => {
    const { server, leaf } = await serve();
    const info = await inspectServerCertificate(`https://localhost:${server.port}`);
    expect(info).toMatchObject({
      subject: 'CN=Claris Self Signed Certificate (Not for Production Use)',
      issuer: 'CN=Claris Root Authority',
      altNames: [],
      sha256: normalizeSha256(leaf.fingerprint256),
      selfSigned: false,
      expired: false
    });

    // The wizard's dialog is shown with this certificate's details; accepting returns the pin.
    const seen: string[] = [];
    const decision = await reviewAndTrustCertificate(
      { name: 'Claris', authMode: 'direct', serverUrl: `https://localhost:${server.port}` },
      { networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
      { confirm: async (message, detail, buttons) => { seen.push(message, detail); return buttons[0]; } }
    );
    expect(decision).toEqual({ sha256: normalizeSha256(leaf.fingerprint256), allowExpired: false });
    expect(seen.join('\n')).toContain('Claris Self Signed Certificate');
    expect(seen.join('\n')).toContain('Claris Root Authority');
    expect(seen.join('\n')).toContain(PLAIN.slice(0, 40));

    const pinned = withPinnedCertificate(
      { id: 'p1', name: 'Claris', authMode: 'direct', serverUrl: `https://localhost:${server.port}`, database: 'Sales', username: 'u' },
      decision as NonNullable<typeof decision>
    );
    expect(await login(server, pinned)).toBe('test-token');
    expect(server.requests[0]?.authorization).toMatch(/^Basic /);
  });

  it('a different certificate than the pinned default one is refused before any credentials are sent', async () => {
    const trusted = clarisDefault();
    const { server } = await serve(); // a second, different "default" certificate
    const result = (await login(server, { pinnedCertSha256: normalizeSha256(trusted.leaf.fingerprint256) })) as FMClientError;
    expect(result.networkCode).toBe('FM_CERT_PIN_MISMATCH');
    expect(server.requests).toHaveLength(0);
  });
});
