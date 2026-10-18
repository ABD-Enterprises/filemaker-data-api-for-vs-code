import { X509Certificate } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { Agent, type AgentOptions } from 'https';
import * as tls from 'tls';

import type { ConnectionProfile } from '../types/fm';
import { CERT_PIN_EXPIRED_CODE, CERT_PIN_MISMATCH_CODE } from '../utils/networkErrors';
import { FMClientError } from './errors';

type TlsProfileOptions = Pick<
  ConnectionProfile,
  'allowSelfSigned' | 'caBundlePath' | 'pinnedCertSha256' | 'pinnedCertAllowExpired'
>;

const agentCache = new Map<string, Agent>();

/**
 * Whether to add the operating system's trusted certificates to Node's built-in public roots (what
 * VS Code itself does unless `http.systemCertificates` is off). Off until the extension turns it
 * on, so unit tests and tools see Node's defaults.
 */
let trustSystemCertificates: () => boolean = () => false;

export function setSystemCertificatePolicy(policy: () => boolean): void {
  trustSystemCertificates = policy;
}

let cachedSystemRoots: string[] | undefined;

/**
 * Node's bundled public roots plus, where this Node can read them (`tls.getCACertificates`, Node
 * 22.15+), the operating system's store. Returns undefined when no addition is possible, meaning
 * "use Node's defaults unchanged".
 */
function systemTrustedRoots(): string[] | undefined {
  if (!trustSystemCertificates()) {
    return undefined;
  }
  const reader = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (typeof reader !== 'function') {
    return undefined;
  }
  if (!cachedSystemRoots) {
    try {
      cachedSystemRoots = [...new Set([...tls.rootCertificates, ...reader.call(tls, 'system')])];
    } catch {
      cachedSystemRoots = [];
    }
  }
  return cachedSystemRoots.length > 0 ? cachedSystemRoots : undefined;
}

/** Normalises a fingerprint to 64 lower-case hex digits, or undefined if it is not one. */
export function normalizeSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const hex = value.replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/** The client's view of a connection to a pinned server, for tests and the trust dialog. */
export function checkPinnedCertificate(
  presented: { fingerprint256?: string; valid_from?: string; valid_to?: string } | undefined,
  pin: { sha256: string; allowExpired: boolean },
  now = Date.now()
): { code: string; message: string } | undefined {
  const fingerprint = normalizeSha256(presented?.fingerprint256);
  if (!fingerprint || fingerprint !== pin.sha256) {
    return { code: CERT_PIN_MISMATCH_CODE, message: 'The server presented a different certificate than the one you trusted.' };
  }
  if (!pin.allowExpired) {
    const from = Date.parse(presented?.valid_from ?? '');
    const to = Date.parse(presented?.valid_to ?? '');
    if (!Number.isNaN(to) && now > to) {
      return { code: CERT_PIN_EXPIRED_CODE, message: 'The certificate you trusted has expired.' };
    }
    if (!Number.isNaN(from) && now < from) {
      return { code: 'CERT_NOT_YET_VALID', message: 'The certificate you trusted is not valid yet.' };
    }
  }
  return undefined;
}

/**
 * An agent that accepts exactly one server certificate, identified by its SHA-256 fingerprint
 * (trust on first use, confirmed by the user). Chain and host-name checks are skipped for that one
 * certificate only. Any other certificate, or the same one after it expired (unless the user
 * accepted that), ends the connection before any request bytes are written.
 *
 * The check runs when the handshake finishes. Writes are corked until then so that nothing, not
 * even the Basic-auth header, can be sent to a server whose certificate is not the pinned one.
 */
class PinnedCertificateAgent extends Agent {
  public constructor(
    options: AgentOptions,
    private readonly pin: { sha256: string; allowExpired: boolean }
  ) {
    super({ ...options, rejectUnauthorized: false });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public createConnection(...args: any[]): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const socket = (super.createConnection as (...a: any[]) => tls.TLSSocket)(...args);
    socket.cork();
    socket.once('secureConnect', () => {
      const failure = checkPinnedCertificate(socket.getPeerCertificate(false), this.pin);
      if (failure) {
        socket.destroy(Object.assign(new Error(failure.message), { code: failure.code }));
        return;
      }
      socket.uncork();
    });
    return socket;
  }
}

export function createHttpsAgentForProfile(profile: TlsProfileOptions): Agent {
  const pinned = normalizeSha256(profile.pinnedCertSha256);
  const allowExpired = pinned !== undefined && profile.pinnedCertAllowExpired === true;
  // Only the older setting turns verification off wholesale. A pin is a narrower choice and wins.
  const allowSelfSigned = pinned === undefined && profile.allowSelfSigned === true;
  const caBundlePath = pinned === undefined ? profile.caBundlePath?.trim() : undefined;
  const systemRoots = pinned === undefined ? systemTrustedRoots() : undefined;

  // Keyed by the file's size and modification time as well as its path, so a renewed or edited
  // CA file is picked up without restarting VS Code.
  let fileStamp = 'none';
  if (caBundlePath) {
    try {
      const info = statSync(caBundlePath);
      fileStamp = `${info.size}:${info.mtimeMs}`;
    } catch (error) {
      throw buildCaBundleError(caBundlePath, error);
    }
  }
  const mode = pinned ? `pinned-${pinned}-${allowExpired ? 'expired-ok' : 'strict'}` : allowSelfSigned ? 'self-signed' : 'verified';
  const prefix = `${mode}:${caBundlePath ?? 'none'}:${systemRoots ? 'system' : 'default'}:`;
  const cacheKey = `${prefix}${fileStamp}`;
  const cachedAgent = agentCache.get(cacheKey);
  if (cachedAgent) {
    return cachedAgent;
  }

  if (pinned) {
    const agent = new PinnedCertificateAgent({}, { sha256: pinned, allowExpired });
    agentCache.set(cacheKey, agent);
    return agent;
  }

  const options: AgentOptions = {
    rejectUnauthorized: !allowSelfSigned
  };

  if (caBundlePath) {
    let pem: string;
    try {
      pem = readFileSync(caBundlePath, 'utf8');
    } catch (error) {
      throw buildCaBundleError(caBundlePath, error);
    }
    assertContainsCertificate(pem, caBundlePath);
    // Node's `ca` option replaces the built-in public roots, which would make every server with
    // a public certificate fail once a custom CA is set. Keep the default roots (and the
    // operating system's, where Node can read them) and add the file's certificates.
    options.ca = [...(systemRoots ?? tls.rootCertificates), pem];
  } else if (systemRoots) {
    options.ca = systemRoots;
  }

  // Drop agents made for an earlier version of the same file.
  for (const key of agentCache.keys()) {
    if (key.startsWith(prefix)) {
      agentCache.delete(key);
    }
  }

  const agent = new Agent(options);
  agentCache.set(cacheKey, agent);
  return agent;
}

function assertContainsCertificate(pem: string, caBundlePath: string): void {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const valid = blocks.filter((block) => {
    try {
      new X509Certificate(block);
      return true;
    } catch {
      return false;
    }
  });
  if (valid.length === 0) {
    throw new FMClientError(
      `The CA file ${caBundlePath} does not contain a certificate. Use a PEM file with "-----BEGIN CERTIFICATE-----" blocks (the CA's public certificate, not a private key).`,
      { code: 'TLS_CA_BUNDLE_INVALID', kind: 'validation', isRetryable: false }
    );
  }
}

function buildCaBundleError(caBundlePath: string, error: unknown): FMClientError {
  return new FMClientError(`Unable to read TLS CA bundle at ${caBundlePath}.`, {
    code: 'TLS_CA_BUNDLE_READ_FAILED',
    details: {
      caBundlePath,
      error
    }
  });
}
