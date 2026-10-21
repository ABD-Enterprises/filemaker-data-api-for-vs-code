import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import type { FMClientError } from '../../src/services/errors';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { describeNetworkFailure, extractNetworkCode } from '../../src/utils/networkErrors';
import { startPlainServer, startTlsServer, type TestTlsServer } from '../helpers/tlsServer';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const PASSWORD = 'pa55-secret-value';

const now = Date.now();
const caKey = newKeyPair();
const ca = makeCertificate({ subjectCn: 'Test Root CA', notBefore: new Date(now - 30 * DAY), notAfter: new Date(now + 365 * DAY), subjectKey: caKey, isCa: true });
const interKey = newKeyPair();
const inter = makeCertificate({ subjectCn: 'Test Intermediate', notBefore: new Date(now - 30 * DAY), notAfter: new Date(now + 365 * DAY), subjectKey: interKey, issuer: { cn: 'Test Root CA', key: caKey }, isCa: true });

function leaf(options: { notBefore?: Date; notAfter?: Date; altNames?: string[]; issuer?: 'ca' | 'intermediate' | 'self' }) {
  const key = newKeyPair();
  const issuer = options.issuer === 'intermediate' ? { cn: 'Test Intermediate', key: interKey } : options.issuer === 'self' ? undefined : { cn: 'Test Root CA', key: caKey };
  return {
    key,
    cert: makeCertificate({
      subjectCn: 'localhost',
      altNames: options.altNames ?? ['localhost'],
      notBefore: options.notBefore ?? new Date(now - DAY),
      notAfter: options.notAfter ?? new Date(now + 30 * DAY),
      subjectKey: key,
      issuer
    })
  };
}

describe('TLS and network failures reach the user as actionable messages', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  let dir: string;
  let caFile: string;

  beforeAll(async () => {
    // nock's pass-through breaks real TLS handshakes (read EINVAL); these tests use real local servers.
    nock.restore();
    dir = await mkdtemp(path.join(tmpdir(), 'tls-failures-'));
    caFile = path.join(dir, 'ca.pem');
    await writeFile(caFile, ca.pem);
  });

  afterAll(async () => {
    nock.activate();
    nock.disableNetConnect();
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function connect(port: number, extra: Partial<ConnectionProfile> = {}, host = 'localhost', scheme = 'https'): Promise<FMClientError> {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', PASSWORD);
    const client = new FMClient(secrets, logger, 3000);
    const profile: ConnectionProfile = {
      id: 'p1', name: 'Test', authMode: 'direct', serverUrl: `${scheme}://${host}:${port}`, database: 'Sales', username: 'tester', ...extra
    };
    try {
      await client.createSession(profile);
    } catch (error) {
      return error as FMClientError;
    }
    throw new Error('expected the connection to fail');
  }

  async function serve(key: ReturnType<typeof newKeyPair>, chain: Array<{ pem: string; der: Buffer; fingerprint256: string }>): Promise<TestTlsServer> {
    const server = await startTlsServer({ key, chain });
    servers.push(server);
    return server;
  }

  const expectCertificateError = (error: FMClientError, code: string, wording: RegExp) => {
    expect(error.networkCode).toBe(code);
    expect(error.kind).toBe('certificate');
    expect(error.isRetryable).toBe(false);
    expect(error.message).toMatch(wording);
    // Never the password, the Basic header, or a long hex blob.
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}/);
  };

  it('expired certificate (CERT_HAS_EXPIRED)', async () => {
    const { key, cert } = leaf({ notBefore: new Date(now - 60 * DAY), notAfter: new Date(now - 2 * DAY) });
    const server = await serve(key, [cert]);
    expectCertificateError(await connect(server.port, { caBundlePath: caFile }), 'CERT_HAS_EXPIRED', /expired.*computer's date and time.*renew/s);
    expect(server.requests).toHaveLength(0);
  });

  it('certificate not valid yet (CERT_NOT_YET_VALID)', async () => {
    const { key, cert } = leaf({ notBefore: new Date(now + 5 * DAY), notAfter: new Date(now + 40 * DAY) });
    const server = await serve(key, [cert]);
    expectCertificateError(await connect(server.port, { caBundlePath: caFile }), 'CERT_NOT_YET_VALID', /not valid yet.*date and time/s);
  });

  it('certificate for another name (ERR_TLS_CERT_ALTNAME_INVALID)', async () => {
    const { key, cert } = leaf({ altNames: ['other.example.com'] });
    const server = await serve(key, [cert]);
    expectCertificateError(await connect(server.port, { caBundlePath: caFile }), 'ERR_TLS_CERT_ALTNAME_INVALID', /not issued for that name/);
  });

  it('self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)', async () => {
    const { key, cert } = leaf({ issuer: 'self' });
    const server = await serve(key, [cert]);
    expectCertificateError(await connect(server.port), 'DEPTH_ZERO_SELF_SIGNED_CERT', /self-signed.*CA certificate.*\.pem/s);
  });

  it('private CA that this computer does not trust (UNABLE_TO_VERIFY_LEAF_SIGNATURE)', async () => {
    const { key, cert } = leaf({});
    const server = await serve(key, [cert]);
    expectCertificateError(await connect(server.port), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', /not trusted by this computer.*CA certificate/s);
  });

  it('server that omits its intermediate certificate (Node reports UNABLE_TO_VERIFY_LEAF_SIGNATURE, so the message names that cause)', async () => {
    const { key, cert } = leaf({ issuer: 'intermediate' });
    const server = await serve(key, [cert]); // chain without the intermediate
    expectCertificateError(await connect(server.port, { caBundlePath: caFile }), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', /missing intermediate certificate/);
  });

  it('a complete chain connects (the CA file extends the system roots)', async () => {
    const { key, cert } = leaf({ issuer: 'intermediate' });
    const server = await serve(key, [cert, inter]);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', PASSWORD);
    const token = await new FMClient(secrets, logger, 3000).createSession({
      id: 'p1', name: 'T', authMode: 'direct', serverUrl: `https://localhost:${server.port}`, database: 'Sales', username: 'tester', caBundlePath: caFile
    });
    expect(token).toBe('test-token');
  });

  it('https to a plain-http port (ERR_SSL_WRONG_VERSION_NUMBER)', async () => {
    const plain = await startPlainServer();
    servers.push(plain);
    const error = await connect(plain.port);
    expect(error.networkCode).toBe('ERR_SSL_WRONG_VERSION_NUMBER');
    expect(error.message).toMatch(/does not speak https/);
    expect(error.isRetryable).toBe(false);
  });

  it('nothing listening (ECONNREFUSED) says so and allows a retry', async () => {
    const plain = await startPlainServer();
    const port = plain.port;
    await plain.close();
    const error = await connect(port);
    expect(error.networkCode).toBe('ECONNREFUSED');
    expect(error.message).toContain(`localhost:${port}`);
    expect(error.message).toMatch(/Nothing is listening/);
    expect(error.isRetryable).toBe(true);
  });

  it('connection dropped (ECONNRESET) does not claim an HTTP status', async () => {
    const dropper = await startPlainServer((destroy) => destroy());
    servers.push(dropper);
    const error = await connect(dropper.port, {}, 'localhost', 'http');
    expect(error.networkCode).toBe('ECONNRESET');
    expect(error.message).toMatch(/closed the connection|only accept https|was closed before answering/);
    expect(error.message).not.toMatch(/HTTP 200/);
  });
});

describe('describeNetworkFailure (codes that need DNS, old TLS or other setups to reproduce)', () => {
  it('maps each code to a distinct, actionable message', () => {
    const ctx = { host: 'fm.example.com', port: '443', protocol: 'https:' };
    const cases: Array<[string, RegExp, boolean]> = [
      ['ENOTFOUND', /could not be found.*VPN/s, false],
      ['EAI_AGAIN', /DNS did not answer/, true],
      ['ETIMEDOUT', /timed out.*firewall/s, true],
      ['EHOSTUNREACH', /no network route/i, true],
      ['SELF_SIGNED_CERT_IN_CHAIN', /self-signed/, false],
      ['UNABLE_TO_GET_ISSUER_CERT', /intermediate/, false],
      ['CERT_UNTRUSTED', /not trusted by this computer/, false],
      ['CERT_REJECTED', /not trusted by this computer/, false],
      ['HOSTNAME_MISMATCH', /not issued for that name/, false],
      ['CERT_REVOKED', /revoked/, false],
      ['FM_CERT_PIN_MISMATCH', /not the one you trusted/, false],
      ['FM_CERT_PIN_EXPIRED', /you trusted.*expired/s, false]
    ];
    for (const [code, wording, retryable] of cases) {
      const failure = describeNetworkFailure(code, ctx);
      expect(failure?.message, code).toMatch(wording);
      expect(failure?.retryable, code).toBe(retryable);
    }
  });

  it('tells old TLS and cipher problems apart from a wrong port', () => {
    const ctx = { host: 'h' };
    expect(describeNetworkFailure('EPROTO', { ...ctx, nodeMessage: 'error:0A00042E:SSL routines::tlsv1 alert protocol version' })?.message).toMatch(/TLS 1\.2 or newer/);
    expect(describeNetworkFailure('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', ctx)?.message).toMatch(/TLS 1\.2 or newer/);
    expect(describeNetworkFailure('EPROTO', { ...ctx, nodeMessage: 'ssl3_read_bytes:sslv3 alert handshake failure' })?.message).toMatch(/cipher/);
    expect(describeNetworkFailure('EPROTO', { ...ctx, nodeMessage: 'wrong version number' })?.message).toMatch(/does not speak https/);
    expect(describeNetworkFailure('EPROTO', ctx)?.message).toMatch(/secure \(TLS\) connection/);
    expect(describeNetworkFailure('SOMETHING_ELSE')).toBeUndefined();
    expect(describeNetworkFailure(undefined)).toBeUndefined();
  });

  it('finds the code on the error, its cause, or the first error of an AggregateError', () => {
    expect(extractNetworkCode({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
    expect(extractNetworkCode({ code: 'ERR_BAD_REQUEST', cause: { code: 'CERT_HAS_EXPIRED' } })).toBe('CERT_HAS_EXPIRED');
    expect(extractNetworkCode({ errors: [{ code: 'ECONNREFUSED' }] })).toBe('ECONNREFUSED');
    expect(extractNetworkCode(new Error('x'))).toBeUndefined();
  });

  it('mentions only the host and port the user typed', () => {
    const message = describeNetworkFailure('ECONNREFUSED', { host: 'fm.example.com', port: '16000' })?.message ?? '';
    expect(message).toContain('fm.example.com:16000');
  });
});
