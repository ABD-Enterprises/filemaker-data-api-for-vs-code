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

/** What Node trusts by default (including NODE_EXTRA_CA_CERTS where Node can say); its bundled list on older Node. */
function defaultTrustedRoots(): string[] {
  const reader = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  try {
    return typeof reader === 'function' ? reader.call(tls, 'default') : [...tls.rootCertificates];
  } catch {
    return [...tls.rootCertificates];
  }
}

let cachedSystemRoots: { roots: string[]; at: number } | undefined;
/** How long the operating system's store is remembered: a CA installed later is picked up after this, or on reload. */
const SYSTEM_ROOTS_TTL_MS = 10 * 60 * 1000;

function readTrustedRoots(): string[] {
  const reader = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (typeof reader !== 'function') {
    return [];
  }
  try {
    // 'default' is what Node trusts out of the box: its bundled list plus NODE_EXTRA_CA_CERTS (and
    // the system store when Node was started with --use-system-ca). Adding 'system' covers the
    // operating system's store. Replacing 'default' by the bundled list alone would drop the
    // certificates the user added through NODE_EXTRA_CA_CERTS.
    return [...new Set([...reader.call(tls, 'default'), ...reader.call(tls, 'system')])];
  } catch {
    return [];
  }
}

/**
 * Reads the operating system's store ahead of the first request. It takes a few hundred
 * milliseconds on some systems, so the extension starts it in the background after activation;
 * a request that arrives first reads it itself.
 */
export function warmSystemCertificates(): void {
  if (!trustSystemCertificates()) {
    return;
  }
  setImmediate(() => {
    cachedSystemRoots = { roots: readTrustedRoots(), at: Date.now() };
  });
}

/**
 * Node's trusted certificates (including NODE_EXTRA_CA_CERTS) plus, where this Node can read them
 * (`tls.getCACertificates`, Node 22.15+), the operating system's store. Returns undefined when no
 * addition is possible, meaning "use Node's defaults unchanged".
 */
function systemTrustedRoots(): string[] | undefined {
  if (!trustSystemCertificates()) {
    return undefined;
  }
  if (typeof (tls as { getCACertificates?: unknown }).getCACertificates !== 'function') {
    return undefined;
  }
  if (!cachedSystemRoots || Date.now() - cachedSystemRoots.at > SYSTEM_ROOTS_TTL_MS) {
    cachedSystemRoots = { roots: readTrustedRoots(), at: Date.now() };
  }
  return cachedSystemRoots.roots.length > 0 ? cachedSystemRoots.roots : undefined;
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
    super(options);
    // `rejectUnauthorized: false` is forced per connection in createConnection and is deliberately
    // NOT kept in `this.options`. When an HTTP proxy applies, axios replaces this agent with a
    // tunnelling one and copies `options` into it; if `rejectUnauthorized: false` were copied too,
    // the tunnelled connection would skip every check and ignore the pin (it would fail open).
    // Without it the copy verifies normally and fails closed. `httpsTransportFor` refuses the
    // combination before a request is made, with a message that says why.
    delete (this.options as { rejectUnauthorized?: boolean }).rejectUnauthorized;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public createConnection(...args: any[]): any {
    for (const arg of args) {
      if (arg && typeof arg === 'object') {
        Object.assign(arg, { rejectUnauthorized: false, checkServerIdentity: () => undefined });
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const socket = (super.createConnection as (...a: any[]) => tls.TLSSocket)(...args);
    // Defence in depth: hold writes until the check has run, so that not even the request line or
    // the Authorization header can reach a server whose certificate is not the pinned one. The check
    // below already ends the connection first (TLS buffers writes until the handshake completes), so
    // this is not known to change the outcome and no test can tell the two apart.
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

/**
 * Environment proxy settings, read the way axios reads them (the `proxy-from-env` rules: the
 * scheme's `*_proxy`, `all_proxy`, `npm_config_*`, either case), and `NO_PROXY`. Only used to decide
 * whether a pinned certificate can be checked: it errs towards "a proxy applies".
 */
export function environmentProxyFor(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  const read = (name: string): string | undefined => env[name.toLowerCase()] || env[name.toUpperCase()] || undefined;
  const proxy =
    read(`npm_config_${scheme}_proxy`) ||
    read(`${scheme}_proxy`) ||
    read('npm_config_proxy') ||
    read('all_proxy') ||
    read('npm_config_all_proxy');
  if (!proxy) {
    return undefined;
  }

  const noProxy = (read('npm_config_no_proxy') || read('no_proxy') || '').toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || (scheme === 'https' ? '443' : '80');
  for (const entry of noProxy.split(/[,\s]+/).filter(Boolean)) {
    if (entry === '*') {
      return undefined;
    }
    const match = /^(.+?)(?::(\d+))?$/.exec(entry);
    const entryHost = (match?.[1] ?? entry).replace(/^\*/, '');
    const entryPort = match?.[2];
    if (entryPort && entryPort !== port) {
      continue;
    }
    if (entryHost.startsWith('.') ? host.endsWith(entryHost) || host === entryHost.slice(1) : host === entryHost || host.endsWith(`.${entryHost}`)) {
      return undefined;
    }
  }
  return proxy;
}

/**
 * The agent for a request to `url`, plus the axios options that go with it. A pinned certificate
 * is checked by the agent's own connection, which an HTTP proxy would bypass, so for a pinned
 * profile axios is told not to use a proxy, and the request is refused (before anything is sent)
 * when an environment proxy applies to the address.
 */
export function httpsTransportFor(
  profile: TlsProfileOptions,
  url: string
): { httpsAgent: Agent; proxy?: false } {
  const httpsAgent = createHttpsAgentForProfile(profile);
  if (normalizeSha256(profile.pinnedCertSha256) === undefined || !/^https:/i.test(url)) {
    return { httpsAgent };
  }
  const proxy = environmentProxyFor(url);
  if (proxy) {
    throw new FMClientError(
      'A proxy is configured on this computer (HTTPS_PROXY or similar), and a trusted (pinned) server certificate cannot be checked through a proxy, so the connection was not made. Add this server to NO_PROXY, remove the proxy setting, or use a custom CA file for this connection instead.',
      { code: 'PIN_THROUGH_PROXY', kind: 'certificate', isRetryable: false }
    );
  }
  return { httpsAgent, proxy: false };
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
    options.ca = [...(systemRoots ?? defaultTrustedRoots()), pem];
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
