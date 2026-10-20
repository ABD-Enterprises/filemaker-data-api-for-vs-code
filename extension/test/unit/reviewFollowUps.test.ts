import { createServer, type Server } from 'http';
import { createServer as createTlsServer } from 'https';
import type { AddressInfo } from 'net';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { certificateTargetUrl, inspectServerCertificate } from '../../src/services/certificateInspect';
import { describeCertificate, quoteCertificateText, reviewAndTrustCertificate } from '../../src/services/certificateTrust';
import { setAgentReplacedPolicy } from '../../src/services/tlsAgent';
import type { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { parseDataApiEnvelope } from '../../src/services/responseGuard';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { selectErrorActions } from '../../src/utils/errorUx';
import { describeNetworkFailure, isFileMakerDefaultCertificate, isTrustableCertificateCode } from '../../src/utils/networkErrors';
import { startTlsServer } from '../helpers/tlsServer';
import { DAY, keyToPem, makeCertificate, newKeyPair } from '../helpers/x509';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const json = (response: Record<string, unknown>, code = '0') => JSON.stringify({ response, messages: [{ code, message: 'x' }] });

describe('certificate dialog text from the server is made safe', () => {
  it('strips control characters and bidirectional overrides, caps the length and quotes the value', () => {
    const quoted = quoteCertificateText(`evil\nSHA-256: 00:11\r\n${String.fromCharCode(0x202e)}Subject: gnirts${String.fromCharCode(0)}`);
    expect([...quoted].every((char) => char.charCodeAt(0) >= 32 && char !== String.fromCharCode(0x202e))).toBe(true);
    expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true);
    expect(JSON.parse(quoted)).toBe('evil SHA-256: 00:11 Subject: gnirts');
    expect(JSON.parse(quoteCertificateText('x'.repeat(5000))).length).toBeLessThanOrEqual(161);
  });

  it('a subject with line breaks cannot add lines to the dialog', () => {
    const lines = describeCertificate({
      host: 'fm.example.com', port: '443', subject: 'CN=evil\nSHA-256: AA:BB\nValid: forever', issuer: 'CN=i Names: x',
      altNames: ['DNS:a\nDNS:b'], validFrom: 'a', validTo: 'b', sha256: 'ab'.repeat(32), expired: false, notYetValid: false, selfSigned: false
    }).split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.filter((line) => line.startsWith('SHA-256:'))).toHaveLength(1);
    expect(lines[1]).toBe('Subject: "CN=evil SHA-256: AA:BB Valid: forever"');
  });
});

describe('trust offers', () => {
  it('the notification button is offered only where trusting makes sense (not for a revoked certificate)', () => {
    const trustCertificate = () => undefined;
    const offer = (networkCode: string) => selectErrorActions({ kind: 'certificate', networkCode }, { trustCertificate });
    expect(offer('CERT_REVOKED')).toEqual([]);
    expect(offer('CERT_HAS_EXPIRED')).toEqual(['Trust this certificate…']);
    expect(offer('CERT_NOT_YET_VALID')).toEqual(['Trust this certificate…']);
    expect(offer('ERR_TLS_CERT_ALTNAME_INVALID')).toEqual(['Trust this certificate…']);
    expect(isTrustableCertificateCode('CERT_HAS_EXPIRED')).toBe(true);
    expect(isTrustableCertificateCode('CERT_REVOKED')).toBe(false);
    expect(isTrustableCertificateCode('ECONNREFUSED')).toBe(false);
  });

  it('every certificate code has a message (none is left undefined)', () => {
    for (const code of ['CERT_REJECTED', 'CERT_UNTRUSTED', 'HOSTNAME_MISMATCH', 'CERT_REVOKED', 'CERT_HAS_EXPIRED']) {
      expect(describeNetworkFailure(code, { host: 'h' })?.message, code).toBeTruthy();
    }
  });

  const profile = { name: 'P', authMode: 'direct' as const, serverUrl: 'https://fm.example.com' };
  const info = (extra: object) => ({
    host: 'fm.example.com', port: '443', subject: 'CN=x', issuer: 'CN=y', altNames: [], validFrom: 'a', validTo: 'b',
    sha256: 'ab'.repeat(32), expired: false, notYetValid: false, selfSigned: false, ...extra
  });

  it('says in the dialog that the review dials directly when a proxy is configured', async () => {
    // This test is about the HTTPS_PROXY note; with VS Code's own setting at its default the dialog also names
    // http.proxySupport, so the setting is taken out of the picture here.
    setAgentReplacedPolicy(() => false);
    const saved = process.env.HTTPS_PROXY;
    try {
      const details: string[] = [];
      const run = () =>
        reviewAndTrustCertificate(profile, {}, { inspect: async () => info({}), confirm: async (_m, detail, buttons) => (details.push(detail), buttons[0]) });
      process.env.HTTPS_PROXY = 'http://proxy:3128';
      await run();
      delete process.env.HTTPS_PROXY;
      await run();
      expect(details[0]).toMatch(/connects directly to the server and does not use the HTTP proxy/);
      expect(details[1]).not.toMatch(/proxy/i);
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
  });

  it('remembers that the user accepted an expired or not-yet-valid certificate, and only then', async () => {
    const seen: string[][] = [];
    const run = (extra: object) =>
      reviewAndTrustCertificate(profile, {}, { inspect: async () => info(extra), confirm: async (_m, _d, buttons) => (seen.push(buttons), buttons[0]) });
    expect(await run({ expired: true })).toEqual({ sha256: 'ab'.repeat(32), allowExpired: true });
    expect(await run({ notYetValid: true })).toEqual({ sha256: 'ab'.repeat(32), allowExpired: true });
    expect(await run({})).toEqual({ sha256: 'ab'.repeat(32), allowExpired: false });
    expect(seen[0]?.[0]).toMatch(/not valid/);
    expect(seen[2]?.[0]).toBe('Trust this certificate');
    // Declining returns nothing.
    expect(await reviewAndTrustCertificate(profile, {}, { inspect: async () => info({}), confirm: async () => undefined })).toBeUndefined();
  });
});

describe('what is shown for an untrusted certificate depends on what the server presents', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  let dir: string;
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const now = Date.now();
  async function login(chainSpec: { cn: string; issuerCn: string; altNames?: string[] }, trustCa = false) {
    const caKey = newKeyPair();
    const ca = makeCertificate({ subjectCn: chainSpec.issuerCn, notBefore: new Date(now - DAY), notAfter: new Date(now + DAY), subjectKey: caKey, isCa: true });
    const key = newKeyPair();
    const leaf = makeCertificate({ subjectCn: chainSpec.cn, altNames: chainSpec.altNames, notBefore: new Date(now - DAY), notAfter: new Date(now + DAY), subjectKey: key, issuer: { cn: chainSpec.issuerCn, key: caKey } });
    const server = await startTlsServer({ key, chain: [leaf] });
    servers.push(server);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    let caBundlePath: string | undefined;
    if (trustCa) {
      dir = await mkdtemp(path.join(tmpdir(), 'wording-'));
      caBundlePath = path.join(dir, 'ca.pem');
      await writeFile(caBundlePath, ca.pem);
    }
    try {
      await new FMClient(secrets, logger, 3000).createSession({ id: 'p1', name: 'T', authMode: 'direct', serverUrl: `https://localhost:${server.port}`, database: 'S', username: 'u', caBundlePath });
    } catch (error) {
      return error as FMClientError;
    }
    throw new Error('expected a failure');
  }

  it('another server with an untrusted chain gets the neutral sentence, not the FileMaker default one', async () => {
    const error = await login({ cn: 'localhost', issuerCn: 'Some Company CA', altNames: ['localhost'] });
    expect(error.message).toMatch(/^This server's certificate is not trusted by this computer\./);
    expect(error.message).toMatch(/missing intermediate certificate/);
    expect(error.message).not.toMatch(/default certificate is self-signed/);
    expect(error.message).not.toMatch(/wizard/);
    expect(error.message).not.toMatch(/\([^)]*\(/); // no nested parentheses
  });

  it('a certificate that lists no host names says so instead of "use a name the certificate lists"', async () => {
    const error = await login({ cn: 'No Names', issuerCn: 'Names CA' }, true);
    expect(error.networkCode).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(error.message).toMatch(/lists no host names/);
    expect(error.message).toMatch(/trust this certificate/i);
    expect(error.message).not.toMatch(/Connect using a name the certificate lists/);
  });

  it('recognises the shape of FileMaker Server\'s default certificate', () => {
    expect(isFileMakerDefaultCertificate({ issuer: 'CN=Claris Root Authority' })).toBe(true);
    expect(isFileMakerDefaultCertificate({ subject: 'CN=Claris Self Signed Certificate (Not for Production Use)' })).toBe(true);
    expect(isFileMakerDefaultCertificate({ subject: 'CN=fm.example.com', issuer: 'CN=Let\'s Encrypt' })).toBe(false);
  });

  it('can read a certificate from a server at an IPv6 literal address', async (context) => {
    const key = newKeyPair();
    const cert = makeCertificate({ subjectCn: 'v6', notBefore: new Date(now - DAY), notAfter: new Date(now + DAY), subjectKey: key });
    const server = createTlsServer({ key: keyToPem(key), cert: cert.pem });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '::1', resolve);
      });
    } catch {
      context.skip(); // no IPv6 loopback on this machine
      return;
    }
    servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    const port = (server.address() as AddressInfo).port;
    const result = await inspectServerCertificate(`https://[::1]:${port}`);
    expect(result.sha256).toBe(cert.fingerprint256.replace(/:/g, '').toLowerCase());
    expect(result.host).toBe('::1');
    expect(certificateTargetUrl({ authMode: 'direct', serverUrl: `https://[::1]:${port}` })).toBe(`https://[::1]:${port}`);
  });
});

describe('sign-in pause details, redirects and the envelope check', () => {
  const servers: Server[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function rig(handlers: { login: () => { status: number; body: string }; data?: (url: string) => { status: number; headers?: Record<string, string>; body: string } }) {
    const log = { posts: 0, gets: 0 };
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.endsWith('/sessions') && request.method === 'POST') {
        log.posts += 1;
        const answer = handlers.login();
        response.statusCode = answer.status;
        response.end(answer.body);
        return;
      }
      log.gets += 1;
      const answer = handlers.data?.(request.url ?? '') ?? { status: 200, body: json({ layouts: [{ name: 'A' }] }) };
      response.statusCode = answer.status;
      for (const [name, value] of Object.entries(answer.headers ?? {})) response.setHeader(name, value);
      response.end(answer.body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    let clock = 1_000_000;
    const fm = new FMClient(secrets, logger, 3000, undefined, undefined, undefined, undefined, () => ({ now: () => clock }));
    const profile: ConnectionProfile = { id: 'p1', name: 'T', authMode: 'direct', serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, database: 'Sales', username: 'u' };
    return { fm, profile, log, setClock: (ms: number) => (clock = ms) };
  }

  const fail = async (promise: Promise<unknown>): Promise<FMClientError> => {
    try {
      await promise;
    } catch (error) {
      return error as FMClientError;
    }
    throw new Error('expected a failure');
  };

  it('error 214 mentions that it may be a timed lockout', async () => {
    const r = await rig({ login: () => ({ status: 401, body: json({}, '214') }) });
    await fail(r.fm.listLayouts(r.profile));
    expect((await fail(r.fm.listLayouts(r.profile))).message).toMatch(/Error 214 can be a temporary lockout/);
    const other = await rig({ login: () => ({ status: 401, body: json({}, '212') }) });
    await fail(other.fm.listLayouts(other.profile));
    expect((await fail(other.fm.listLayouts(other.profile))).message).not.toMatch(/temporary lockout/);
  });

  it('error 1703 (a different kind of sign-in is needed) pauses automatic sign-ins too', async () => {
    const r = await rig({ login: () => ({ status: 401, body: json({}, '1703') }) });
    await fail(r.fm.listLayouts(r.profile));
    await fail(r.fm.listLayouts(r.profile));
    expect(r.log.posts).toBe(1);
  });

  it('a failed renewal ahead of expiry does not pause sign-ins while the token still works, and is not retried each time', async () => {
    let mode: 'ok' | 'rejected' = 'ok';
    const r = await rig({ login: () => (mode === 'ok' ? { status: 200, body: json({ token: 'tok' }) } : { status: 401, body: json({}, '212') }) });
    expect(await r.fm.listLayouts(r.profile)).toEqual(['A']);
    expect(r.log.posts).toBe(1);

    mode = 'rejected';
    r.setClock(1_000_000 + 20 * 60 * 1000); // past the 14-minute renewal point
    r.fm.invalidateProfileCache('p1');
    expect(await r.fm.listLayouts(r.profile)).toEqual(['A']); // the old token still works
    expect(r.log.posts).toBe(2);
    expect(r.fm.isSignInPaused('p1')).toBe(false);

    for (let i = 0; i < 4; i += 1) {
      r.fm.invalidateProfileCache('p1');
      await r.fm.listLayouts(r.profile);
    }
    expect(r.log.posts).toBe(2); // no more renewal attempts, so no more failed logins
  });

  it('the session-limit wait is capped at five minutes and is reported as retryAfterMs', async () => {
    const r = await rig({ login: () => ({ status: 500, body: json({}, '956') }) });
    for (let i = 0; i < 9; i += 1) {
      await fail(r.fm.createSession(r.profile, { userInitiated: true }));
    }
    const waiting = await fail(r.fm.listLayouts(r.profile));
    expect(waiting.code).toBe('956');
    expect(waiting.retryAfterMs).toBeLessThanOrEqual(300_000);
    expect(waiting.retryAfterMs).toBeGreaterThan(299_000);
  });

  it('forgetProfile removes the pause and health of a throwaway profile id', async () => {
    const r = await rig({ login: () => ({ status: 401, body: json({}, '212') }) });
    await fail(r.fm.listLayouts(r.profile));
    expect(r.fm.isSignInPaused('p1')).toBe(true);
    expect(r.fm.getHealth('p1')).toBeDefined();
    r.fm.forgetProfile('p1');
    expect(r.fm.isSignInPaused('p1')).toBe(false);
    expect(r.fm.getHealth('p1')).toBeUndefined();
  });

  it('an authenticated request that is answered with a redirect is not followed', async () => {
    const other = await rig({ login: () => ({ status: 200, body: json({ token: 'x' }) }) });
    const r = await rig({
      login: () => ({ status: 200, body: json({ token: 'tok' }) }),
      data: () => ({ status: 307, headers: { Location: `${other.profile.serverUrl}/fmi/data/vLatest/databases/Sales/layouts` }, body: '' })
    });
    const error = await fail(r.fm.listLayouts(r.profile));
    expect(error.status).toBe(307);
    expect(error.message).toMatch(/redirected to a different address/);
    expect(other.log.gets).toBe(0);
  });

  it('the envelope needs both "response" and a "messages" array', () => {
    const run = (data: unknown) => () => parseDataApiEnvelope({ status: 200, data, headers: {} });
    expect(run({ response: {} })).toThrow(/without the Data API/);
    expect(run({ messages: [] })).toThrow(/without the Data API/);
    expect(run({ response: {}, messages: 'x' })).toThrow(/without the Data API/);
    expect(run({ response: {}, messages: [{ code: '0', message: 'OK' }] })).not.toThrow();
  });
});
