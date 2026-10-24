import type { ConnectionProfile } from '../../types/fm';
import { FMClientError } from '../errors';
import { certificateTargetUrl, inspectServerCertificate } from '../certificateInspect';
import { describeNetworkFailure, isFileMakerDefaultCertificate, targetOfUrl } from '../../utils/networkErrors';
import { environmentProxyFor, pinBypassedByHost } from '../tlsAgent';

const CERTIFICATE_LOOK_TTL_MS = 60_000;

/** Best-effort certificate advice, cached independently of a profile's session. */
export class CertificateAdvice {
  /** The better certificate message (or none) per server and failure code, kept briefly so repeated failures do not each pay for a look. */
  private readonly certificateLooks = new Map<string, { at: number; message: Promise<string | undefined> }>();

  public constructor(private readonly now: () => number) {}

  /**
   * When the certificate was refused because this computer does not trust its issuer, look at what
   * the server presents (one extra handshake, no request, at most 1.5 s, made directly and not through any proxy) and, if it is FileMaker Server's own
   * default certificate, say so in the message. Best effort: any problem returns the error as it was.
   */
  public async refine(profile: ConnectionProfile, failure: FMClientError): Promise<FMClientError> {
    const untrusted = new Set([
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN'
    ]);
    const bypassed = pinBypassedByHost(profile, failure);
    if (bypassed) {
      return bypassed;
    }
    if (failure.kind !== 'certificate' || !failure.networkCode || !untrusted.has(failure.networkCode)) {
      return failure;
    }
    const url = certificateTargetUrl(profile);
    // This look dials the server directly; behind a proxy it would only hang, so it is skipped there.
    if (!url || environmentProxyFor(url)) {
      return failure;
    }
    // One look per server and failure for a minute: every failed request would otherwise pay the
    // handshake again (up to 1.5 s), and a server that does not answer would cost the full wait each time.
    const key = `${url}|${failure.networkCode}`;
    const now = this.now();
    let look = this.certificateLooks.get(key);
    if (!look || now - look.at > CERTIFICATE_LOOK_TTL_MS || now < look.at) {
      if (this.certificateLooks.size >= 32) {
        this.certificateLooks.delete(this.certificateLooks.keys().next().value as string);
      }
      look = { at: now, message: lookAtCertificate(url, failure.networkCode) };
      this.certificateLooks.set(key, look);
    }
    const message = await look.message;
    return message
      ? new FMClientError(message, {
          status: failure.status,
          code: failure.code,
          networkCode: failure.networkCode,
          kind: failure.kind,
          isRetryable: failure.isRetryable,
          details: failure.details,
          requestId: failure.requestId,
          endpoint: failure.endpoint
        })
      : failure;
  }
}

/** The message that names what the server presented, or undefined when the look fails or adds nothing. */
async function lookAtCertificate(url: string, networkCode: string): Promise<string | undefined> {
  try {
    const info = await inspectServerCertificate(url, 1500);
    const better = describeNetworkFailure(networkCode, {
      ...targetOfUrl(url),
      fileMakerDefaultCertificate: isFileMakerDefaultCertificate(info),
      certificateListsHostNames: info.altNames.length > 0
    });
    return better?.message;
  } catch {
    return undefined;
  }
}
