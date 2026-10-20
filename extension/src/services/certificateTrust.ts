import * as vscode from 'vscode';

import type { ConnectionProfile } from '../types/fm';
import { describeNetworkFailure, isFileMakerDefaultCertificate, targetOfUrl } from '../utils/networkErrors';
import { certificateTargetUrl, formatFingerprint, inspectServerCertificate, type ServerCertificateInfo } from './certificateInspect';
import { environmentProxyFor, hostReplacesAgentFor, normalizeSha256 } from './tlsAgent';

export { certificateTargetUrl, inspectServerCertificate, type ServerCertificateInfo };

export interface TrustDecision {
  sha256: string;
  /** The user accepted a certificate that is expired or not yet valid. */
  allowExpired: boolean;
}

const MAX_FIELD_CHARS = 160;

/**
 * Certificate text comes from the server, so before it goes into a dialog it is stripped of control
 * characters (line breaks that could fake extra lines, bidirectional overrides that could reorder
 * the text), cut to a sensible length and shown as a quoted JSON string.
 */
export function quoteCertificateText(value: string): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = cleaned.length > MAX_FIELD_CHARS ? `${cleaned.slice(0, MAX_FIELD_CHARS)}…` : cleaned;
  return JSON.stringify(cut);
}

export function describeCertificate(info: ServerCertificateInfo): string {
  const names = info.altNames.slice(0, 6).map(quoteCertificateText).join(', ') + (info.altNames.length > 6 ? `, and ${info.altNames.length - 6} more` : '');
  return [
    `Server: ${quoteCertificateText(`${info.host}${info.port === '443' ? '' : `:${info.port}`}`)}`,
    `Subject: ${info.subject ? quoteCertificateText(info.subject) : '(none)'}`,
    `Issuer: ${info.issuer ? quoteCertificateText(info.issuer) : '(none)'}${info.selfSigned ? ' (self-signed)' : ''}`,
    `Names: ${names || '(none listed)'}`,
    `Valid: ${info.validFrom} to ${info.validTo}${info.expired ? '  EXPIRED' : info.notYetValid ? '  NOT VALID YET' : ''}`,
    `SHA-256: ${formatFingerprint(info.sha256)}`
  ].join('\n');
}

/** This look at the certificate dials the server directly. Say so when a proxy is configured for it. */
const PROXY_NOTE = (url: string): string =>
  environmentProxyFor(url)
    ? ' Note: this check connects directly to the server and does not use the HTTP proxy configured on this computer, and a trusted (pinned) certificate cannot be used through a proxy. To use it, add this server\'s host name to NO_PROXY so the connection goes direct.'
    : '';

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
      `${failure?.message ?? 'The server\'s certificate could not be read. Check the address and that the server is reachable.'}${PROXY_NOTE(url)}`
    );
    return undefined;
  }

  const previous = normalizeSha256(options.previousSha256);
  const changed = previous !== undefined && previous !== info.sha256;
  // The same wording as the error message: recognise FileMaker Server's default certificate, and drop
  // the CA-file advice when the certificate lists no host names (a CA file could not make it pass).
  const why =
    describeNetworkFailure(options.networkCode, {
      ...targetOfUrl(url),
      fileMakerDefaultCertificate: isFileMakerDefaultCertificate(info),
      certificateListsHostNames: info.altNames.length > 0
    })?.message ?? (info.verifyError ? `This computer does not trust it (${info.verifyError}).` : undefined);
  const lines = [
    changed ? 'The server\'s certificate is different from the one you trusted before.' : undefined,
    why ? `Why it was refused: ${why}` : undefined,
    '',
    describeCertificate(info),
    changed ? `\nPreviously trusted: ${formatFingerprint(previous)}` : undefined,
    '',
    PROXY_NOTE(url).trim() || undefined,
    'Only continue if you recognise this fingerprint (ask your FileMaker administrator, or compare it with the one in the Admin Console). ' +
      (hostReplacesAgentFor(url)
        ? 'Note: VS Code\'s "http.proxySupport" setting is "override" (its default), which replaces the extension\'s own connection. Until you set it to "fallback", this trust cannot take effect (VS Code\'s normal certificate check applies instead) and the extension cannot warn you if the certificate changes.'
        : 'The extension will then accept exactly this certificate for this connection, and warn you if it ever changes.')
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
