import type { AxiosError } from 'axios';

import { FMClientError } from '../services/errors';
import type { NormalizeErrorOptions, NormalizedError, NormalizedErrorKind } from '../types/errors';
import { getFileMakerErrorInfo } from './fileMakerCodes';
import { describeNetworkFailure, extractNetworkCode, extractNetworkMessage, targetOfUrl } from './networkErrors';
import { plainTextPreview } from './plainText';
import { redactHeaders, redactValue } from './redact';

interface FileMakerMessage {
  code: string;
  message: string;
}

export function normalizeError(error: unknown, options?: NormalizeErrorOptions): NormalizedError {
  if (isNormalizedError(error)) {
    return mergeOptions(error, options);
  }

  if (error instanceof FMClientError) {
    return mergeOptions(error.toNormalized(), options);
  }

  if (isAxiosErrorLike(error)) {
    return mergeOptions(normalizeAxiosError(error, options), options);
  }

  if (isAbortError(error)) {
    return mergeOptions(
      {
        kind: 'cancellation',
        message: 'Request cancelled.',
        isRetryable: false,
        details: redactValue(toUnknownRecord(error))
      },
      options
    );
  }

  if (error instanceof Error) {
    return mergeOptions(
      {
        kind: 'unknown',
        message: error.message || options?.fallbackMessage || 'Unexpected error.',
        isRetryable: false,
        details: redactValue({
          name: error.name,
          message: error.message
        }),
        originalName: error.name
      },
      options
    );
  }

  return mergeOptions(
    {
      kind: 'unknown',
      message: options?.fallbackMessage ?? 'Unexpected error.',
      isRetryable: false,
      details: redactValue(error)
    },
    options
  );
}

function normalizeAxiosError(error: AxiosError, options?: NormalizeErrorOptions): NormalizedError {
  const status = error.response?.status ?? options?.status;
  const payload = error.response?.data;
  const fmMessage = extractFileMakerMessage(payload);
  const safeHeaders = redactHeaders(toUnknownRecord(error.response?.headers));
  const retryAfterMs = parseRetryAfterMs(error.response?.headers);
  const details = safeDetails(payload);

  // A connection that never produced an HTTP response: map Node's error code to a message that
  // says what happened and what to do (certificates, DNS, refused, reset, old TLS ...).
  if (!error.response) {
    const networkCode = extractNetworkCode(error);
    const failure = describeNetworkFailure(networkCode, {
      ...targetOfUrl(error.config?.url),
      nodeMessage: extractNetworkMessage(error) ?? error.message
    });
    if (failure) {
      return {
        kind: failure.kind,
        message: failure.message,
        networkCode: failure.code,
        isRetryable: failure.retryable,
        details,
        originalName: error.name
      };
    }
  }

  const timeoutLike = error.code === 'ECONNABORTED' || /timeout/i.test(error.message);
  if (timeoutLike) {
    const seconds = error.config?.timeout ? Math.round(error.config.timeout / 1000) : undefined;
    return {
      kind: 'timeout',
      message: options?.fallbackMessage
        ? `${options.fallbackMessage} (request timed out${seconds ? ` after ${seconds} s` : ''}${status ? `, HTTP ${status}` : ''}). If the server is slow, raise the setting filemaker.requestTimeoutMs.`
        : `Request timed out${seconds ? ` after ${seconds} s` : ''}${status ? ` (HTTP ${status})` : ''}. If the server is slow, raise the setting filemaker.requestTimeoutMs.`,
      status,
      safeHeaders,
      isRetryable: true,
      details
    };
  }

  if (error.code === 'ERR_CANCELED' || isAbortError(error.cause)) {
    return {
      kind: 'cancellation',
      message: options?.fallbackMessage
        ? `${options.fallbackMessage} (request cancelled).`
        : 'Request cancelled.',
      status,
      safeHeaders,
      isRetryable: false,
      details
    };
  }

  const code = fmMessage?.code;
  const info = getFileMakerErrorInfo(code);
  // A FileMaker credentials problem is an authentication failure whatever the HTTP status was.
  const kind: NormalizedErrorKind = info?.category === 'credentials' ? 'auth' : inferKind(status);
  const rejectedLogin = info?.category === 'credentials' || status === 401;
  const resolvedMessage =
    (fmMessage
      ? `FileMaker API error${status ? ` (HTTP ${status})` : ''} [${fmMessage.code}]: ${fmMessage.message}${info?.advice ? ` ${info.advice}` : ''}`
      : buildFallbackAxiosMessage(error, options, status)) +
    (rejectedLogin ? cloudSignInNote(error.config?.url) : '');

  // Retry only what can change: a transport problem, or a server error that is not a FileMaker
  // answer. FileMaker's own errors (HTTP 500 with a code) are answers, not outages, unless the
  // code is one that clears (a locked record, a full session pool, a restarting host).
  const transportOrGateway = kind === 'network' || kind === 'timeout' || status === 429;
  const serverOutage = kind === 'server' && !fmMessage;
  const isRetryable = fmMessage ? info?.retryable === true : transportOrGateway || serverOutage;

  return {
    kind,
    message: resolvedMessage,
    status,
    code,
    fmCategory: info?.category,
    safeHeaders,
    isRetryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    details,
    originalName: error.name
  };
}

function buildFallbackAxiosMessage(
  error: AxiosError,
  options: NormalizeErrorOptions | undefined,
  status: number | undefined
): string {
  const hint = status ? (redirectHint(error, status) ?? statusHint(status)) : undefined;
  if (options?.fallbackMessage) {
    if (!status && error.message && isTlsCertificateMessage(error.message)) {
      return `${options.fallbackMessage} (${error.message})`;
    }
    return status
      ? `${options.fallbackMessage} (HTTP ${status})${hint ? ` ${hint}` : ''}`
      : options.fallbackMessage;
  }

  if (status) {
    return `Request failed with HTTP ${status}.${hint ? ` ${hint}` : ''}`;
  }

  return error.message || 'Network request failed.';
}

/**
 * The Data API does not redirect, and the client does not follow redirects (a redirect could send
 * a login to another server). Say where the server pointed: the scheme and host only, which are
 * safe to show; the path and query (which can hold tokens) are left out.
 */
function redirectHint(error: AxiosError, status: number): string | undefined {
  if (![301, 302, 303, 307, 308].includes(status)) {
    return undefined;
  }
  const headers = error.response?.headers as Record<string, unknown> | undefined;
  const raw = headers?.location ?? headers?.Location;
  const location = typeof raw === 'string' ? raw : undefined;
  if (!location) {
    return undefined;
  }
  try {
    const from = new URL(error.config?.url ?? '');
    const to = new URL(location, from);
    if (from.protocol === 'https:' && to.protocol === 'http:') {
      return `The server redirected from https to plain http (${to.protocol}//${to.host}); that downgrade is refused. Check the Server URL and the server's HTTPS settings.`;
    }
    if (to.origin !== from.origin) {
      return `The server redirected to a different address (${to.origin}). Credentials are not sent there. If that is the right server, use it as the Server URL.`;
    }
    return `The server redirected to another path on the same server (${to.origin}). The Data API should not redirect: check the API base path, and for a sign-in page in front of the server.`;
  } catch {
    return undefined;
  }
}

/** What a status without a FileMaker error body most likely means. */
function statusHint(status: number): string | undefined {
  switch (status) {
    case 301:
    case 302:
    case 303:
    case 307:
    case 308:
      return 'The server redirected the request; the Data API does not redirect. Use the final address as the Server URL (check http vs https, and any sign-in page in front of the server).';
    case 403:
      return 'The server refused the request: your account may lack the privilege, or a gateway or firewall blocked it. Ask your FileMaker administrator; editing this connection will not help.';
    case 404:
      return 'Nothing answered at that address. Check the Server URL, the API base path and version, the database name, and that the FileMaker Data API is enabled (Admin Console > Connectors).';
    case 413:
      return 'The request was too large for the server or a gateway in front of it.';
    case 429:
      return 'The server (or a gateway) is receiving too many requests and asked for a pause.';
    case 502:
    case 503:
    case 504:
      return 'A gateway or proxy could not reach FileMaker Server, or it did not answer in time. The server may be restarting or overloaded; try again shortly.';
    default:
      return undefined;
  }
}

/**
 * FileMaker Cloud signs the Data API in with a Claris ID token (an `FMID` header), which this
 * extension does not implement; a Claris ID account name and password are rejected there like a wrong
 * password. Say so when the host looks like FileMaker Cloud (`*.filemaker-cloud.com`, which covers
 * `*.account.filemaker-cloud.com`; the pattern is from Claris examples, not a documented rule).
 */
function cloudSignInNote(url: string | undefined): string {
  try {
    if (url && /\.filemaker-cloud\.com$/i.test(new URL(url).hostname)) {
      return ' This looks like a FileMaker Cloud server. Cloud signs in with a Claris ID token, which this extension does not support yet, so the account and password you entered cannot work there even if they are correct.';
    }
  } catch {
    // not a URL: no note
  }
  return '';
}

/** `Retry-After` as milliseconds: delay-seconds or an HTTP date; capped at five minutes. */
function parseRetryAfterMs(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const record = headers as Record<string, unknown>;
  const raw = record['retry-after'] ?? record['Retry-After'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== 'string' && typeof text !== 'number') {
    return undefined;
  }
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 300_000);
  }
  const date = Date.parse(String(text));
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 300_000);
}

const MAX_DETAIL_TEXT = 300;

/**
 * Response bodies end up in "Copy as Bug Report". A gateway's HTML error page can name internal
 * hosts, so text bodies are reduced to plain text and cut short; JSON stays (redacted).
 */
function safeDetails(payload: unknown): unknown {
  if (typeof payload === 'string') {
    return redactValue(plainTextPreview(payload, MAX_DETAIL_TEXT));
  }
  return redactValue(payload);
}

function isTlsCertificateMessage(message: string): boolean {
  return /self[- ]signed|certificate verify failed|certificate chain|unable to verify|unable to get local issuer|cert_has_expired|self_signed_cert|unable_to_verify_leaf_signature|unable_to_get_issuer_cert|unable_to_get_issuer_cert_locally|err_tls_cert_altname_invalid/i.test(
    message
  );
}

function mergeOptions(error: NormalizedError, options: NormalizeErrorOptions | undefined): NormalizedError {
  return {
    ...error,
    requestId: options?.requestId ?? error.requestId,
    endpoint: options?.endpoint ?? error.endpoint,
    status: options?.status ?? error.status,
    safeHeaders: options?.safeHeaders ?? error.safeHeaders,
    message: error.message || options?.fallbackMessage || 'Unexpected error.'
  };
}

function extractFileMakerMessage(payload: unknown): FileMakerMessage | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    return undefined;
  }

  const first = record.messages[0];
  if (!first || typeof first !== 'object') {
    return undefined;
  }

  const messageRecord = first as Record<string, unknown>;
  const code = messageRecord.code;
  const message = messageRecord.message;
  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }

  return {
    code,
    message
  };
}

function inferKind(status: number | undefined): NormalizedErrorKind {
  if (status === 401 || status === 403) {
    return 'auth';
  }

  if (typeof status === 'number' && status >= 400 && status < 500) {
    return 'validation';
  }

  if (typeof status === 'number' && status >= 500) {
    return 'server';
  }

  return 'network';
}

function isAbortError(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.name === 'AbortError' || record.code === 'ABORT_ERR';
}

function isAxiosErrorLike(value: unknown): value is AxiosError {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.isAxiosError === true;
}

function isNormalizedError(value: unknown): value is NormalizedError {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string' && typeof record.message === 'string';
}

function toUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  return value as Record<string, unknown>;
}
