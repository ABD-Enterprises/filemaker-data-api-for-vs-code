import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { ProfileStore } from '../../src/services/profileStore';
import { parseConnectionProfileTemplate } from '../../src/services/profileTemplate';
import { SecretStore } from '../../src/services/secretStore';
import { normalizeSha256 } from '../../src/services/tlsAgent';
import type { ConnectionProfile } from '../../src/types/fm';
import { startTlsServer, type TestTlsServer } from '../helpers/tlsServer';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';
import { InMemoryMemento, InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const now = Date.now();

function selfSigned(options: { altNames?: string[]; notBefore?: Date; notAfter?: Date } = {}) {
  const key = newKeyPair();
  const cert = makeCertificate({
    subjectCn: 'fm.internal',
    altNames: options.altNames ?? ['fm.internal'], // never the name we connect with ("localhost")
    notBefore: options.notBefore ?? new Date(now - DAY),
    notAfter: options.notAfter ?? new Date(now + 30 * DAY),
    subjectKey: key
  });
  return { key, cert };
}

describe('pinning one server certificate', () => {
  const servers: TestTlsServer[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function serve(material: ReturnType<typeof selfSigned>): Promise<TestTlsServer> {
    const server = await startTlsServer({ key: material.key, chain: [material.cert] });
    servers.push(server);
    return server;
  }

  async function login(server: TestTlsServer, extra: Partial<ConnectionProfile>): Promise<FMClientError | string> {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'the-password');
    const fm = new FMClient(secrets, logger, 3000);
    try {
      return await fm.createSession({
        id: 'p1', name: 'T', authMode: 'direct', serverUrl: `https://localhost:${server.port}`, database: 'Sales', username: 'u', ...extra
      });
    } catch (error) {
      return error as FMClientError;
    }
  }

  it('accepts exactly the pinned certificate, skipping the host-name and issuer checks for it', async () => {
    const material = selfSigned(); // self-signed AND issued for another name than "localhost"
    const server = await serve(material);
    expect(await login(server, { pinnedCertSha256: normalizeSha256(material.cert.fingerprint256) })).toBe('test-token');
    expect(server.requests[0]?.authorization).toMatch(/^Basic /);
  });

  it('without a pin the same certificate is refused, and nothing is sent', async () => {
    const server = await serve(selfSigned());
    const result = (await login(server, {})) as FMClientError;
    expect(result.networkCode).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(server.requests).toHaveLength(0);
  });

  it('a different certificate than the pinned one is a hard failure, before any request bytes', async () => {
    const trusted = selfSigned();
    const swapped = selfSigned();
    const server = await serve(swapped);
    const result = (await login(server, { pinnedCertSha256: normalizeSha256(trusted.cert.fingerprint256) })) as FMClientError;
    expect(result).toBeInstanceOf(FMClientError);
    expect(result.networkCode).toBe('FM_CERT_PIN_MISMATCH');
    expect(result.kind).toBe('certificate');
    expect(result.isRetryable).toBe(false);
    expect(result.message).toMatch(/not the one you trusted.*Review and re-trust/s);
    expect(server.requests).toHaveLength(0); // the password never left this computer
  });

  it('a pin overrides the older "skip all checks" flag: a swapped certificate is still refused', async () => {
    const trusted = selfSigned();
    const server = await serve(selfSigned());
    const result = (await login(server, { allowSelfSigned: true, pinnedCertSha256: normalizeSha256(trusted.cert.fingerprint256) })) as FMClientError;
    expect(result.networkCode).toBe('FM_CERT_PIN_MISMATCH');
    expect(server.requests).toHaveLength(0);
  });

  it('refuses a pinned certificate that has expired, unless the user accepted that', async () => {
    const material = selfSigned({ notBefore: new Date(now - 60 * DAY), notAfter: new Date(now - DAY) });
    const server = await serve(material);
    const pin = normalizeSha256(material.cert.fingerprint256);

    const refused = (await login(server, { pinnedCertSha256: pin })) as FMClientError;
    expect(refused.networkCode).toBe('FM_CERT_PIN_EXPIRED');
    expect(refused.message).toMatch(/you trusted.*expired/s);
    expect(server.requests).toHaveLength(0);

    expect(await login(server, { pinnedCertSha256: pin, pinnedCertAllowExpired: true })).toBe('test-token');
  });

  it('refuses a pinned certificate that is not valid yet', async () => {
    const material = selfSigned({ notBefore: new Date(now + 5 * DAY), notAfter: new Date(now + 40 * DAY) });
    const server = await serve(material);
    const refused = (await login(server, { pinnedCertSha256: normalizeSha256(material.cert.fingerprint256) })) as FMClientError;
    expect(refused.networkCode).toBe('CERT_NOT_YET_VALID');
  });

  it('no verification is disabled unless the legacy flag is present', async () => {
    const expired = selfSigned({ notBefore: new Date(now - 60 * DAY), notAfter: new Date(now - DAY) });
    const server = await serve(expired);
    const refusals = [await login(server, {}), await login(server, { allowSelfSigned: false })] as FMClientError[];
    for (const refusal of refusals) {
      expect(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT']).toContain(refusal.networkCode);
    }
    expect(server.requests).toHaveLength(0);
    // The older flag still works, as before (it skips every check).
    expect(await login(server, { allowSelfSigned: true })).toBe('test-token');
  });

  it('stored pins are read leniently: normalised, and dropped when unusable', async () => {
    const store = new ProfileStore(new InMemoryMemento() as never, new InMemoryMemento() as never);
    const fingerprint = makeCertificate({ subjectCn: 'x', notBefore: new Date(now - DAY), notAfter: new Date(now + DAY), subjectKey: newKeyPair() }).fingerprint256;
    const base = { name: 'P', authMode: 'direct' as const, serverUrl: 'https://fm.example.com', database: 'S', username: 'u' };

    await store.upsertProfile({ ...base, id: 'a', pinnedCertSha256: fingerprint, pinnedCertAllowExpired: true });
    expect(await store.getProfile('a')).toMatchObject({ pinnedCertSha256: normalizeSha256(fingerprint), pinnedCertAllowExpired: true });

    await store.upsertProfile({ ...base, id: 'b', pinnedCertSha256: 'not-a-fingerprint', pinnedCertAllowExpired: true });
    const dropped = await store.getProfile('b');
    expect(dropped?.pinnedCertSha256).toBeUndefined();
    expect(dropped?.pinnedCertAllowExpired).toBeUndefined();

    // Hydration of a hand-edited store with odd values never throws.
    const memento = new InMemoryMemento();
    await memento.update('filemakerDataApiTools.profiles', [{ ...base, id: 'c', pinnedCertSha256: 42, pinnedCertAllowExpired: 'yes' }]);
    const lenient = new ProfileStore(memento as never, new InMemoryMemento() as never);
    expect(await lenient.getProfile('c')).toMatchObject({ id: 'c' });
  });

  it('a workspace profile template cannot set the pin or the older flag', () => {
    for (const field of ['pinnedCertSha256', 'pinnedCertAllowExpired', 'allowSelfSigned', 'caBundlePath']) {
      const result = parseConnectionProfileTemplate(
        JSON.stringify({ name: 'T', authMode: 'direct', serverUrl: 'https://fm.example.com', database: 'S', [field]: field === 'pinnedCertSha256' ? 'a'.repeat(64) : true })
      );
      expect(result.template, field).toBeUndefined();
      expect(result.warning, field).toMatch(/unsupported fields/);
    }
  });
});
