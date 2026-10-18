import * as tls from 'tls';

import * as vscode from 'vscode';

import type { ConnectionProfile } from '../types/fm';
import { describeNetworkFailure, targetOfUrl } from '../utils/networkErrors';
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

export interface TrustDecision {
  sha256: string;
  /** The user accepted a certificate that is expired or not yet valid. */
  allowExpired: boolean;
}

/** The address a TLS handshake goes to: the proxy in proxy mode, otherwise the server. https only. */
export function certificateTargetUrl(profile: Pick<ConnectionProfile, 'authMode' | 'serverUrl' | 'proxyEndpoint'>): string | undefined {
  const url = profile.authMode === 'proxy' ? profile.proxyEndpoint : profile.serverUrl;
  return url && /^https:/i.test(url) ? url : undefined;
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
  const host = target.host ?? '';
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

/** Fingerprint in the groups people compare: `AB:CD:...`. */
export function formatFingerprint(sha256: string): string {
  return sha256.toUpperCase().replace(/(..)(?=.)/g, '$1:');
}

export function describeCertificate(info: ServerCertificateInfo): string {
  const names = info.altNames.slice(0, 6).join(', ') + (info.altNames.length > 6 ? `, and ${info.altNames.length - 6} more` : '');
  return [
    `Server: ${info.host}${info.port === '443' ? '' : `:${info.port}`}`,
    `Subject: ${info.subject || '(none)'}`,
    `Issuer: ${info.issuer || '(none)'}${info.selfSigned ? ' (self-signed)' : ''}`,
    `Names: ${names || '(none listed)'}`,
    `Valid: ${info.validFrom} to ${info.validTo}${info.expired ? '  EXPIRED' : info.notYetValid ? '  NOT VALID YET' : ''}`,
    `SHA-256: ${formatFingerprint(info.sha256)}`
  ].join('\n');
}

export interface TrustFlowDeps {
  inspect?: (url: string) => Promise<ServerCertificateInfo>;
  /** Shows the dialog; resolves to the label of the pressed button, or undefined if dismissed. */
  confirm?: (message: string, detail: string, buttons: string[]) => Promise<string | undefined>;
}

/**
 * "Trust this certificate…": reads the certificate the server presents now, shows who it is for and
 * why the normal checks failed, and asks. Accepting returns the fingerprint to pin for this one
 * connection. `networkCode` is the failure that led here, if any (used for the explanation);
 * `previousSha256` is the fingerprint trusted before, which makes this a "certificate changed"
 * review.
 */
export async function reviewAndTrustCertificate(
  profile: Pick<ConnectionProfile, 'name' | 'authMode' | 'serverUrl' | 'proxyEndpoint'>,
  options: { networkCode?: string; previousSha256?: string },
  deps: TrustFlowDeps = {}
): Promise<TrustDecision | undefined> {
  const url = certificateTargetUrl(profile);
  if (!url) {
    return undefined;
  }
  const inspect = deps.inspect ?? inspectServerCertificate;
  const confirm =
    deps.confirm ??
    (async (message, detail, buttons) =>
      vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons));

  let info: ServerCertificateInfo;
  try {
    info = await inspect(url);
  } catch (error) {
    const failure = describeNetworkFailure((error as { code?: string }).code, targetOfUrl(url));
    void vscode.window.showErrorMessage(
      failure?.message ?? 'The server\'s certificate could not be read. Check the address and that the server is reachable.'
    );
    return undefined;
  }

  const previous = normalizeSha256(options.previousSha256);
  const changed = previous !== undefined && previous !== info.sha256;
  const why = describeNetworkFailure(options.networkCode, targetOfUrl(url))?.message ?? (info.verifyError ? `This computer does not trust it (${info.verifyError}).` : undefined);
  const lines = [
    changed ? 'The server\'s certificate is different from the one you trusted before.' : undefined,
    why ? `Why it was refused: ${why}` : undefined,
    '',
    describeCertificate(info),
    changed ? `\nPreviously trusted: ${formatFingerprint(previous)}` : undefined,
    '',
    'Only continue if you recognise this fingerprint (ask your FileMaker administrator, or compare it with the one in the Admin Console). The extension will then accept exactly this certificate for this connection, and warn you if it ever changes.'
  ].filter((line): line is string => line !== undefined);

  const expiredNote = info.expired || info.notYetValid;
  const buttonLabel = expiredNote
    ? 'Trust anyway, although it is not valid'
    : changed
      ? 'Trust the new certificate'
      : 'Trust this certificate';
  const answer = await confirm(
    `Trust this certificate for "${profile.name}"?`,
    lines.join('\n'),
    [buttonLabel]
  );
  if (answer !== buttonLabel) {
    return undefined;
  }
  return { sha256: info.sha256, allowExpired: expiredNote };
}

/** A copy of the profile with the user's decision applied: pinned, and the older blanket flag removed. */
export function withPinnedCertificate(profile: ConnectionProfile, decision: TrustDecision): ConnectionProfile {
  return {
    ...profile,
    pinnedCertSha256: decision.sha256,
    pinnedCertAllowExpired: decision.allowExpired ? true : undefined,
    allowSelfSigned: undefined
  };
}
