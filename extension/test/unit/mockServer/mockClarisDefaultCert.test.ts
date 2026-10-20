import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  reviewAndTrustCertificate,
  withPinnedCertificate
} from '../../../src/services/certificateTrust';
import type { FMClientError } from '../../../src/services/errors';
import { FMClient } from '../../../src/services/fmClient';
import { SecretStore } from '../../../src/services/secretStore';
import type { ConnectionProfile } from '../../../src/types/fm';
import { InMemorySecretStorage } from '../mocks';
import { type RunningMock, startMockProcess } from './mockHelper';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

/** The leaf and the server as a real FileMaker Server 22 with its default certificate presents them. */
describe.skipIf(!hasOpenssl)(
  "FileMaker Server's default certificate, end to end, connecting by IP address",
  () => {
    let mock: RunningMock;
    let other: RunningMock;

    beforeAll(async () => {
      nock.restore();
      mock = await startMockProcess({ TLS: 'claris-default-cert' });
      other = await startMockProcess({ TLS: 'claris-default-cert' }); // a second server with its own, different certificate
    });
    afterAll(async () => {
      await mock.stop();
      await other.stop();
      nock.activate();
      nock.disableNetConnect();
    });

    const profile = (
      serverUrl: string,
      extra: Partial<ConnectionProfile> = {}
    ): ConnectionProfile => ({
      id: 'p1',
      name: 'ABD',
      authMode: 'direct',
      serverUrl,
      database: 'Quality',
      username: 'tester',
      ...extra
    });
    async function client(): Promise<FMClient> {
      const secrets = new SecretStore(new InMemorySecretStorage() as never);
      await secrets.setPassword('p1', 'testpass1');
      return new FMClient(secrets, logger, 5000);
    }
    async function failure(run: () => Promise<unknown>): Promise<FMClientError> {
      try {
        await run();
      } catch (error) {
        return error as FMClientError;
      }
      throw new Error('expected a failure');
    }
    function presented(url: string): Promise<{ raw: Buffer; protocol: string | null }> {
      const { hostname, port } = new URL(url);
      return new Promise((resolve, reject) => {
        const socket = tls.connect(
          { host: hostname, port: Number(port), rejectUnauthorized: false },
          () => {
            const raw = socket.getPeerCertificate(false).raw;
            const protocol = socket.getProtocol();
            socket.end();
            resolve({ raw, protocol });
          }
        );
        socket.on('error', reject);
      });
    }

    it('is the same shape as the real one: version 1, no extensions at all, TLS 1.2, names as the Claris certificate has them', async () => {
      expect(mock.baseUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/); // an IP address, not a name
      const { raw, protocol } = await presented(mock.baseUrl);
      const text = execFileSync('openssl', ['x509', '-inform', 'DER', '-noout', '-text'], {
        input: raw,
        encoding: 'utf8'
      });
      expect(text).toMatch(/Version: 1 \(0x0\)/);
      expect(text).not.toMatch(/X509v3/);
      expect(text).toMatch(/Serial Number: 1 \(0x1\)/);
      const cert = new X509Certificate(raw);
      expect(cert.subjectAltName).toBeUndefined();
      expect(cert.subject.split('\n')).toEqual([
        'C=US',
        'ST=California',
        'L=Santa Clara',
        'O=Claris International Inc.',
        'CN=Claris Self Signed Certificate (Not for Production Use)'
      ]);
      expect(cert.issuer).toContain('CN=Claris Root Authority');
      expect(cert.issuer).toContain('OU=Copyright (c) 2026 Claris International Inc.');
      expect(cert.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
      expect(protocol).toBe('TLSv1.2');
    });

    it("is refused first, in plain words that name FileMaker Server's default certificate", async () => {
      const error = await failure(async () =>
        (await client()).getProductInfo(profile(mock.baseUrl))
      );
      expect(error.networkCode).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
      expect(error.message).toMatch(/FileMaker Server's default certificate is self-signed/);
      expect(error.message).toMatch(/You can trust this certificate/);
    });

    it('can then be trusted by fingerprint, and the connection and the sign-in work', async () => {
      const refused = await failure(async () =>
        (await client()).getProductInfo(profile(mock.baseUrl))
      );

      let dialog = { message: '', detail: '', buttons: [] as string[] };
      const decision = await reviewAndTrustCertificate(
        { name: 'ABD', authMode: 'direct', serverUrl: mock.baseUrl },
        { networkCode: refused.networkCode },
        {
          confirm: async (message, detail, buttons) => {
            dialog = { message, detail, buttons };
            return buttons[0];
          }
        }
      );
      // What the user is shown: the same subject and issuer lines a real server's dialog showed on the owner's machine,
      // why it was refused, that the certificate lists no names, and what trusting does.
      expect(dialog.message).toBe('Trust this certificate for "ABD"?');
      expect(dialog.detail).toMatch(
        /Why it was refused: .*FileMaker Server's default certificate is self-signed/
      );
      expect(dialog.detail).toContain(
        'Subject: "CN=Claris Self Signed Certificate (Not for Production Use), O=Claris International Inc., C=US"'
      );
      expect(dialog.detail).toContain(
        'Issuer: "CN=Claris Root Authority, O=Claris International Inc., OU=Claris International Inc.+Copyright (c) 2026 Claris International Inc., C=US"'
      );
      expect(dialog.detail).toMatch(/Names: \(none listed\)/);
      expect(dialog.detail).toMatch(/SHA-256: [0-9A-F]{2}(:[0-9A-F]{2}){31}/);
      expect(dialog.buttons).toEqual(['Trust this certificate']);
      expect(decision?.allowExpired).toBe(false);

      const pinned = withPinnedCertificate(profile(mock.baseUrl), decision!);
      const c = await client();
      expect((await c.getProductInfo(pinned)).name).toBeTruthy();
      const token = await c.createSession(pinned);
      expect(token).toBeTruthy();
      await c.deleteSession(pinned);
    });

    it('refuses a different Claris default certificate than the one that was trusted, before anything is sent', async () => {
      const { raw } = await presented(mock.baseUrl);
      const trusted = new X509Certificate(raw).fingerprint256.replace(/:/g, '').toLowerCase();
      const error = await failure(async () =>
        (await client()).createSession(profile(other.baseUrl, { pinnedCertSha256: trusted }))
      );
      expect(error.networkCode).toBe('FM_CERT_PIN_MISMATCH');
    });
  }
);
