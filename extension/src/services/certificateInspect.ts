import * as tls from 'tls';

import type { ConnectionProfile } from '../types/fm';
import { targetOfUrl } from '../utils/networkErrors';
import { normalizeSha256 } from './tlsAgent';

/** What a server presented during the TLS handshake. Read without sending any request. */
export interface ServerCertificateInfo {
  host: string;
  port: string;
  subject: string;
  issuer: string;
  altNames: string[];
  validFrom: string;
  validTo: string;
  /** SHA-256 fingerprint as 64 lower-case hex digits. */
  sha256: string;
  expired: boolean;
  notYetValid: boolean;
  selfSigned: boolean;
  /** The reason OpenSSL gave for not trusting it by the normal rules, if any. */
  verifyError?: string;
}


function nameOf(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as Record<string, string | string[]>;
  const parts: string[] = [];
  for (const key of ['CN', 'O', 'OU', 'C']) {
    const entry = record[key];
    if (entry) {
      parts.push(`${key}=${Array.isArray(entry) ? entry.join('+') : entry}`);
    }
  }
  return parts.join(', ');
}

/**
 * Connects, completes the TLS handshake without verifying anything, reads the certificate the
 * server presents and closes. No request, header or credential is sent.
 */
export function inspectServerCertificate(url: string, timeoutMs = 8000): Promise<ServerCertificateInfo> {
  const target = targetOfUrl(url);
  // new URL('https://[::1]').hostname is '[::1]'; the socket wants the bare address.
  const host = (target.host ?? '').replace(/^\[|\]$/g, '');
  const port = target.port || '443';
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port: Number(port),
      servername: /^[\d.]+$|:/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: timeoutMs
    });
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once('timeout', () => fail(Object.assign(new Error('Timed out reading the certificate.'), { code: 'ETIMEDOUT' })));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate(false);
      const verifyError = socket.authorizationError ? String(socket.authorizationError) : undefined;
      socket.end();
      const sha256 = normalizeSha256(certificate.fingerprint256);
      if (!sha256) {
        reject(new Error('The server did not present a certificate.'));
        return;
      }
      const from = Date.parse(certificate.valid_from);
      const to = Date.parse(certificate.valid_to);
      const subject = nameOf(certificate.subject);
      const issuer = nameOf(certificate.issuer);
      resolve({
        host,
        port,
        subject,
        issuer,
        altNames: (certificate.subjectaltname ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
        validFrom: certificate.valid_from,
        validTo: certificate.valid_to,
        sha256,
        expired: !Number.isNaN(to) && Date.now() > to,
        notYetValid: !Number.isNaN(from) && Date.now() < from,
        selfSigned: subject !== '' && subject === issuer,
        verifyError
      });
    });
  });
}

/** The address a TLS handshake goes to: the proxy in proxy mode, otherwise the server. https only. */
export function certificateTargetUrl(
  profile: Pick<ConnectionProfile, 'authMode' | 'serverUrl' | 'proxyEndpoint'>
): string | undefined {
  const url = profile.authMode === 'proxy' ? profile.proxyEndpoint : profile.serverUrl;
  return url && /^https:/i.test(url) ? url : undefined;
}

/** Fingerprint in the groups people compare: `AB:CD:...`. */
export function formatFingerprint(sha256: string): string {
  return sha256.toUpperCase().replace(/(..)(?=.)/g, '$1:');
}

