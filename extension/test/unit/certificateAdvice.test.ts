import { afterEach, describe, expect, it } from 'vitest';

import { reviewAndTrustCertificate } from '../../src/services/certificateTrust';
import type { FMClientError } from '../../src/services/errors';
import { httpsTransportFor, normalizeSha256 } from '../../src/services/tlsAgent';
import { getFileMakerErrorInfo } from '../../src/utils/fileMakerCodes';
import { describeNetworkFailure } from '../../src/utils/networkErrors';

/** Which advice each certificate message gives, and that none of it points at something that cannot work. */

const UNTRUSTED_CODES = [
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_REJECTED'
];
const ALL_CERT_CODES = [
  ...UNTRUSTED_CODES,
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'CERT_REVOKED',
  'FM_CERT_PIN_MISMATCH',
  'FM_CERT_PIN_EXPIRED'
];

describe("FileMaker Server's default certificate: the message never offers a CA file", () => {
  for (const code of UNTRUSTED_CODES) {
    it(`${code}: trusting the certificate is the action, and a CA file is not mentioned`, () => {
      const message = describeNetworkFailure(code, { host: 'fm.example.com', fileMakerDefaultCertificate: true })?.message ?? '';
      expect(message).toMatch(/^This server uses a certificate that is not trusted/);
      expect(message).toMatch(/You can trust this certificate/);
      expect(message).not.toMatch(/CA file|CA certificate|\.pem/i);
    });
  }
});

describe('other certificates: the CA file is offered only where it can work', () => {
  for (const code of UNTRUSTED_CODES) {
    it(`${code}: trusting the certificate comes first; the CA file is the second option and names its condition`, () => {
      const message = describeNetworkFailure(code, { host: 'fm.example.com' })?.message ?? '';
      const trust = message.indexOf('trust this certificate');
      const caFile = message.indexOf("CA file");
      expect(trust).toBeGreaterThanOrEqual(0);
      expect(caFile).toBeGreaterThan(trust);
      // It works only for a certificate that lists the server's host names, and says so.
      expect(message).toMatch(/lists its host names/);
    });
  }

  it('no other certificate message mentions a CA file (host-name, expiry, pin and revocation problems cannot be fixed with one)', () => {
    for (const code of ALL_CERT_CODES.filter((entry) => !UNTRUSTED_CODES.includes(entry))) {
      for (const fileMakerDefaultCertificate of [true, false]) {
        const message = describeNetworkFailure(code, { host: 'fm.example.com', fileMakerDefaultCertificate })?.message ?? '';
        expect(message, code).not.toMatch(/CA file|CA certificate/i);
        expect(message.length, code).toBeGreaterThan(0);
      }
    }
  });

  it('the host-name message for a certificate with no names offers trusting it, not a CA file', () => {
    const failure = describeNetworkFailure('ERR_TLS_CERT_ALTNAME_INVALID', {
      host: 'fm.example.com',
      nodeMessage: "Hostname/IP does not match certificate's altnames: Cert does not contain a DNS name"
    });
    expect(failure?.message).toMatch(/lists no host names/);
    expect(failure?.message).toMatch(/trust this certificate/);
    expect(failure?.message).not.toMatch(/CA file/);
  });
});

describe('a trusted (pinned) certificate behind an environment proxy', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
  });

  const PIN = 'ab'.repeat(32);

  function refusal(): FMClientError {
    process.env.HTTPS_PROXY = 'http://proxy.example.com:3128';
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      httpsTransportFor({ pinnedCertSha256: normalizeSha256(PIN) }, 'https://fm.example.com:443');
    } catch (error) {
      return error as FMClientError;
    }
    throw new Error('expected a refusal');
  }

  it('says what works: NO_PROXY so the connection goes direct, or forget the pin and use a CA file for a certificate with host names', () => {
    const error = refusal();
    expect(error.code).toBe('PIN_THROUGH_PROXY');
    expect(error.message).toMatch(/add this server's host name to NO_PROXY/);
    expect(error.message).toMatch(/forget the trusted certificate and use a CA file for a certificate that lists the server's host names/);
  });

  it('does not tell the user to use a CA file as if it would help the pinned profile', () => {
    const message = refusal().message;
    expect(message).not.toMatch(/or use a custom CA file for this connection instead/);
    expect(message).toMatch(/does not help here/);
  });

  it('the trust dialog tells the same story: a pinned certificate cannot use the proxy; NO_PROXY makes it direct', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example.com:3128';
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    const details: string[] = [];
    await reviewAndTrustCertificate(
      { name: 'T', authMode: 'direct', serverUrl: 'https://127.0.0.1:1' },
      { networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
      {
        inspect: async () => ({
          subject: 'CN=x', issuer: 'CN=y', altNames: [], sha256: PIN, validFrom: new Date(0).toISOString(), validTo: new Date(Date.now() + 1e9).toISOString(),
          expired: false, notYetValid: false, selfSigned: true
        }) as never,
        confirm: async (_message, detail) => {
          details.push(detail);
          return undefined;
        }
      }
    );
    const dialog = details.join('\n');
    expect(dialog).toMatch(/connects directly to the server and does not use the HTTP proxy/);
    expect(dialog).toMatch(/add this server's host name to NO_PROXY so the connection goes direct/);
    // The proxy note itself gives only the NO_PROXY route (the refusal text above may mention a CA file).
    expect(dialog.split('\n').find((line) => line.startsWith('Note:'))).not.toMatch(/CA file/);
  });
});


describe('the trust dialog explains the refusal in the same words as the error message', () => {
  const PIN = 'ab'.repeat(32);
  const info = (overrides: Record<string, unknown>) =>
    ({
      subject: 'CN=x', issuer: 'CN=y', altNames: [], sha256: PIN, validFrom: new Date(0).toISOString(),
      validTo: new Date(Date.now() + 1e9).toISOString(), expired: false, notYetValid: false, selfSigned: false, ...overrides
    }) as never;

  async function dialogFor(certificate: Record<string, unknown>): Promise<string> {
    const details: string[] = [];
    await reviewAndTrustCertificate(
      { name: 'T', authMode: 'direct', serverUrl: 'https://fm.example.com' },
      { networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
      { inspect: async () => info(certificate), confirm: async (_m, detail) => (details.push(detail), undefined) }
    );
    return details.join('\n');
  }

  it("FileMaker Server's default certificate gets the plain wording and no CA-file advice", async () => {
    const dialog = await dialogFor({ subject: 'CN=Claris Self Signed Certificate (Not for Production Use)', issuer: 'CN=Claris Root Authority' });
    expect(dialog).toContain("Why it was refused: This server uses a certificate that is not trusted: FileMaker Server's default certificate is self-signed.");
    expect(dialog).not.toMatch(/CA file|CA certificate/);
  });

  it('any certificate that lists no host names gets no CA-file advice either', async () => {
    const dialog = await dialogFor({ altNames: [] });
    expect(dialog).toMatch(/Why it was refused: This server's certificate is not trusted/);
    expect(dialog).not.toMatch(/CA file|CA certificate/);
  });

  it('a certificate with host names (a private authority) still gets the CA-file option, second', async () => {
    const dialog = await dialogFor({ altNames: ['fm.example.com'] });
    expect(dialog.indexOf('trust this certificate')).toBeLessThan(dialog.indexOf('CA file'));
    expect(dialog).toMatch(/lists its host names/);
  });
});

describe('error 956', () => {
  it("keeps pointing at Admin Console > Databases (where Data API clients are listed and disconnected), not the Connectors tab", () => {
    const info = getFileMakerErrorInfo('956');
    expect(info?.advice).toContain('Admin Console > Databases');
    expect(info?.advice).not.toContain('Connectors');
    // Claris's own wording for the error.
    expect(info?.meaning).toMatch(/maximum number of database or Admin API sessions/);
  });
});

describe('describeNetworkFailure with a certificate that lists no host names', () => {
  it('drops the CA-file advice for untrusted-chain codes, whichever certificate it is', () => {
    for (const code of UNTRUSTED_CODES) {
      const message = describeNetworkFailure(code, { host: 'h', certificateListsNoHostNames: true })?.message ?? '';
      expect(message, code).toMatch(/trust this certificate/);
      expect(message, code).not.toMatch(/CA file|CA certificate/);
    }
  });
});
