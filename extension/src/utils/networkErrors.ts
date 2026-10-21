/**
 * One mapping from Node's low-level error codes to messages a person can act on. Used by every
 * surface (Test Connection, Connect, Explorer, Query Builder, batch, Script Runner, AI tools)
 * through `normalizeError`, so the same failure reads the same everywhere.
 *
 * Messages say what happened and what to do or ask, never include credentials, and name only the
 * host (and port) the user typed in the connection.
 */
export type NetworkFailureKind = 'certificate' | 'network' | 'timeout';

export interface NetworkFailure {
  /** The Node / OpenSSL code (`CERT_HAS_EXPIRED`, `ECONNREFUSED`, ...). */
  code: string;
  kind: NetworkFailureKind;
  message: string;
  /** Trying the identical request again could succeed. */
  retryable: boolean;
  /** The failure is a certificate problem the user may review and trust (pin). */
  trustable?: boolean;
}

export interface NetworkFailureContext {
  /** Host the user typed (no scheme, no credentials). */
  host?: string;
  port?: string;
  /** `https:` or `http:` as typed. */
  protocol?: string;
  /** The message Node produced; used only to tell apart failures that share one code. */
  nodeMessage?: string;
  /** The certificate is FileMaker Server's own default one (found by looking at what the server presents). */
  fileMakerDefaultCertificate?: boolean;
  /**
   * The certificate is known to list host names. A CA file is offered only then: without that knowledge
   * (the look at the certificate was skipped or failed) it could be a certificate with no names, for which
   * a CA file cannot make host-name verification pass.
   */
  certificateListsHostNames?: boolean;
}

/**
 * The plain-words opening for "this computer does not trust the certificate". Two forms: the exact
 * shape of FileMaker Server's default certificate (a self-signed "Claris" certificate from a private
 * root, which a new installation uses until the administrator installs another), and a neutral one
 * for every other server, where a missing intermediate certificate is the common cause. Neither
 * names a screen, because the same text appears in the wizard and in a notification.
 */
const UNTRUSTED_FILEMAKER_DEFAULT =
  "This server uses a certificate that is not trusted: FileMaker Server's default certificate is self-signed. You can trust this certificate, or install a certificate from a public authority on the server.";
const UNTRUSTED_NEUTRAL =
  "This server's certificate is not trusted by this computer. The certificate chain could not be verified, and a missing intermediate certificate on the server is a common cause. You can trust this certificate, or ask the administrator to install the full certificate chain.";

/** Whether a presented certificate has the shape of FileMaker Server's default one. */
export function isFileMakerDefaultCertificate(certificate: { subject?: string; issuer?: string }): boolean {
  return /Claris Root Authority/i.test(certificate.issuer ?? '') || /Claris Self Signed Certificate/i.test(certificate.subject ?? '');
}

const CLOCK_HINT = "First check that your computer's date and time are correct.";
/**
 * The CA-file alternative. It only works for a certificate that lists the server's host names
 * (a private CA's certificate), so it is never offered for FileMaker Server's default certificate,
 * which has no host names and would still fail host-name verification with a CA file.
 */
const CA_HINT =
  "Or, if the server's certificate lists its host names and was issued by your company's own authority, ask your FileMaker administrator for that CA certificate (a .pem file) and set it as the connection's CA file.";
const caHint = (context: NetworkFailureContext): string =>
  context.certificateListsHostNames === true && !context.fileMakerDefaultCertificate ? ` ${CA_HINT}` : '';

/** Error codes that are certificate problems, with the certificate-specific wording. */
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_SSL_CERTIFICATE_VERIFY_FAILED'
]);

/** Shared advice for a pin refused before connecting through a proxy. */
export const PIN_THROUGH_PROXY_MESSAGE = "A proxy is configured on this computer (HTTPS_PROXY, VS Code http.proxy, or a system/PAC proxy), and a trusted (pinned) server certificate cannot be checked through a proxy, so the connection was not made. For an environment proxy, add this server's host name to NO_PROXY so the connection goes direct. For a VS Code or system proxy, exclude the server in that proxy's settings, or remove the proxy setting. A custom CA file does not help here, because a trusted certificate does not use the CA file. To keep the proxy, forget the trusted certificate and use a CA file for a certificate that lists the server's host names.";

/** Stable code for a certificate that differs from the one the user pinned. */
export const CERT_PIN_MISMATCH_CODE = 'FM_CERT_PIN_MISMATCH';
/** Stable code for a pinned certificate that has expired. */
export const CERT_PIN_EXPIRED_CODE = 'FM_CERT_PIN_EXPIRED';

export function isCertificateCode(code: string | undefined): boolean {
  return code !== undefined && (CERTIFICATE_CODES.has(code) || code === CERT_PIN_MISMATCH_CODE || code === CERT_PIN_EXPIRED_CODE);
}

/**
 * The Node error code for a failure, looking at the error itself, its `cause`, and the first of an
 * AggregateError (Node tries IPv4 and IPv6 and reports both).
 */
export function extractNetworkCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string | undefined => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) {
      return undefined;
    }
    seen.add(value);
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string' && isKnownNetworkCode(record.code)) {
      return record.code;
    }
    const fromCause = visit(record.cause, depth + 1);
    if (fromCause) {
      return fromCause;
    }
    if (Array.isArray(record.errors)) {
      for (const inner of record.errors) {
        const found = visit(inner, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return visit(error, 0);
}

/** The Node message that goes with the code, for telling apart failures that share a code. */
export function extractNetworkMessage(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string | undefined => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) {
      return undefined;
    }
    seen.add(value);
    const record = value as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string' && isKnownNetworkCode(record.code) && typeof record.message === 'string') {
      return record.message;
    }
    const fromCause = visit(record.cause, depth + 1);
    if (fromCause) {
      return fromCause;
    }
    if (Array.isArray(record.errors)) {
      for (const inner of record.errors) {
        const found = visit(inner, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return visit(error, 0);
}

function isKnownNetworkCode(code: string): boolean {
  return (
    code === 'PIN_THROUGH_PROXY' ||
    CERTIFICATE_CODES.has(code) ||
    code === CERT_PIN_MISMATCH_CODE ||
    code === CERT_PIN_EXPIRED_CODE ||
    code.startsWith('ERR_SSL_') ||
    code === 'EPROTO' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  );
}

function where(context: NetworkFailureContext): string {
  if (!context.host) {
    return 'the server';
  }
  return context.port ? `${context.host}:${context.port}` : context.host;
}

/** Describes a network or TLS failure by its Node code, or undefined when the code is not known. */
export function describeNetworkFailure(
  code: string | undefined,
  context: NetworkFailureContext = {}
): NetworkFailure | undefined {
  if (!code) {
    return undefined;
  }
  const nodeMessage = context.nodeMessage ?? '';
  const target = where(context);

  switch (code) {
    case 'CERT_HAS_EXPIRED':
      return {
        code,
        kind: 'certificate',
        retryable: false,
        trustable: true,
        message: `The security certificate of ${target} has expired. ${CLOCK_HINT} If your clock is right, ask your FileMaker administrator to renew and install a current certificate (Admin Console > Configuration > SSL Certificate).`
      };
    case 'CERT_NOT_YET_VALID':
      return {
        code,
        kind: 'certificate',
        retryable: false,
        trustable: true,
        message: `The security certificate of ${target} is not valid yet. ${CLOCK_HINT} If your clock is right, ask your FileMaker administrator to install a certificate that is already valid.`
      };
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return {
        code,
        kind: 'certificate',
        retryable: false,
        trustable: true,
        message: `${context.fileMakerDefaultCertificate ? UNTRUSTED_FILEMAKER_DEFAULT : `The certificate of ${target} is self-signed, and this computer does not trust it. You can trust this certificate, or install one from a public authority on the server.`}${caHint(context)}`
      };
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_UNTRUSTED':
    case 'CERT_REJECTED':
      return {
        code,
        kind: 'certificate',
        retryable: false,
        trustable: true,
        message: `${context.fileMakerDefaultCertificate ? UNTRUSTED_FILEMAKER_DEFAULT : UNTRUSTED_NEUTRAL}${caHint(context)}`
      };
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'HOSTNAME_MISMATCH':
      return {
        code,
        kind: 'certificate',
        retryable: false,
        trustable: true,
        message: /does not contain a DNS name|cert is empty|is not cert's CN|no (subject )?alt/i.test(nodeMessage)
          ? `The certificate of ${target} lists no host names, so it cannot match the name you connected with. You can trust this certificate, or ask the administrator for one issued for this server's name.`
          : `The certificate of ${target} was not issued for that name. Connect using a name the certificate lists (not an IP address unless it is listed), or ask the administrator which host name the certificate was issued for.`
      };
    case 'CERT_REVOKED':
      return {
        code,
        kind: 'certificate',
        retryable: false,
        message: `The certificate of ${target} has been revoked. Ask your FileMaker administrator to install a new certificate.`
      };
    case 'PIN_THROUGH_PROXY':
      return { code, kind: 'certificate', retryable: false, message: PIN_THROUGH_PROXY_MESSAGE };
    case CERT_PIN_MISMATCH_CODE:
      return {
        code,
        kind: 'certificate',
        retryable: false,
        trustable: true,
        message: `The certificate of ${target} is not the one you trusted for this connection. It was replaced, or something else is answering for the server. If your administrator renewed the certificate, choose "Review and re-trust"; otherwise do not continue.`
      };
    case CERT_PIN_EXPIRED_CODE:
      return {
        code,
        kind: 'certificate',
        retryable: false,
        trustable: true,
        message: `The certificate you trusted for ${target} has expired. Ask the administrator to renew it, then review and re-trust the new certificate.`
      };
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return {
        code,
        kind: 'network',
        retryable: false,
        message: `${target} does not speak https on that port (it answered in plain text or another protocol). Check the port number, or use http:// only if the server really offers plain http.`
      };
    case 'ECONNREFUSED':
      return {
        code,
        kind: 'network',
        retryable: true,
        message: `Nothing is listening on ${target}. Check the server address and port, and that FileMaker Server and its Data API are running.`
      };
    case 'ENOTFOUND':
      return {
        code,
        kind: 'network',
        retryable: false,
        message: `The name ${context.host ?? 'of the server'} could not be found. Check the spelling of the server address and, if the server is on a company network, that your VPN is connected.`
      };
    case 'EAI_AGAIN':
      return {
        code,
        kind: 'network',
        retryable: true,
        message: `The name ${context.host ?? 'of the server'} could not be looked up right now (DNS did not answer). Check your network connection or VPN and try again.`
      };
    case 'ETIMEDOUT':
      return {
        code,
        kind: 'timeout',
        retryable: true,
        message: `Connecting to ${target} timed out. A firewall may be dropping the traffic, or the server is unreachable. Check your network or VPN, and the address and port.`
      };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return {
        code,
        kind: 'network',
        retryable: true,
        message: `There is no network route to ${target}. Check your network connection or VPN.`
      };
    case 'ECONNRESET':
    case 'EPIPE':
      return {
        code,
        kind: 'network',
        retryable: true,
        message:
          context.protocol === 'http:'
            ? `The connection to ${target} was closed. The server may only accept https; try an https:// address.`
            : `The server closed the connection to ${target} before answering. It may have restarted, or a firewall or proxy dropped the connection. Try again; if it keeps happening, ask your administrator.`
      };
    default:
      break;
  }

  if (code === 'EPROTO' || code.startsWith('ERR_SSL_')) {
    if (/wrong version number/i.test(nodeMessage)) {
      return describeNetworkFailure('ERR_SSL_WRONG_VERSION_NUMBER', context);
    }
    if (/protocol[_ ]version|unsupported[_ ]protocol|no[_ ]protocols[_ ]available|tlsv1 alert|ssl alert number 70|version too low|ssl3_get_record/i.test(`${nodeMessage} ${code}`)) {
      return {
        code,
        kind: 'network',
        retryable: false,
        message: `${target} only offers old TLS versions that this extension refuses (it requires TLS 1.2 or newer). Ask your FileMaker administrator to enable TLS 1.2 or newer on the server or proxy.`
      };
    }
    if (/handshake[_ ]failure|no[_ ]shared[_ ]cipher|no cipher/i.test(`${nodeMessage} ${code}`)) {
      return {
        code,
        kind: 'network',
        retryable: false,
        message: `The secure connection to ${target} could not be set up: no TLS version or cipher is shared with the server. Ask your administrator to enable TLS 1.2 or newer with common ciphers.`
      };
    }
    return {
      code,
      kind: 'network',
      retryable: false,
      message: `The secure (TLS) connection to ${target} could not be set up. Check that the address and port are for an https service and that the server's TLS settings are current.`
    };
  }

  if (code === 'ECONNABORTED') {
    return undefined;
  }
  return undefined;
}

/** Host and port exactly as the user typed them in a server URL; empty for anything unparsable. */
export function targetOfUrl(url: string | undefined): NetworkFailureContext {
  if (!url) {
    return {};
  }
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: parsed.port || undefined, protocol: parsed.protocol };
  } catch {
    return {};
  }
}

/** Certificate failures a person may sensibly decide to trust (as opposed to, say, a revoked certificate). */
export function isTrustableCertificateCode(code: string | undefined): boolean {
  return describeNetworkFailure(code)?.trustable === true;
}
