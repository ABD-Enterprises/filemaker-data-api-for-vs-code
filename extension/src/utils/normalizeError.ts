import type { AxiosError } from 'axios';

import { FMClientError } from '../services/errors';
import type { NormalizeErrorOptions, NormalizedError, NormalizedErrorKind } from '../types/errors';
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

  const timeoutLike = error.code === 'ECONNABORTED' || /timeout/i.test(error.message);
  if (timeoutLike) {
    return {
      kind: 'timeout',
      message: options?.fallbackMessage
        ? `${options.fallbackMessage} (request timed out${status ? `, HTTP ${status}` : ''}).`
        : `Request timed out${status ? ` (HTTP ${status})` : ''}.`,
      status,
      safeHeaders,
      isRetryable: true,
      details: redactValue(payload)
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
      details: redactValue(payload)
    };
  }

  const kind = inferKind(status);
  const code = fmMessage?.code;
  const resolvedMessage = fmMessage
    ? `FileMaker API error${status ? ` (HTTP ${status})` : ''} [${fmMessage.code}]: ${fmMessage.message}`
    : buildFallbackAxiosMessage(error, options, status);

  return {
    kind,
    message: resolvedMessage,
    status,
    code,
    safeHeaders,
    isRetryable: kind === 'network' || kind === 'timeout' || kind === 'server',
    details: redactValue(payload),
    originalName: error.name
  };
}

function buildFallbackAxiosMessage(
  error: AxiosError,
  options: NormalizeErrorOptions | undefined,
  status: number | undefined
): string {
  if (options?.fallbackMessage) {
    if (!status && error.message && isTlsCertificateMessage(error.message)) {
      return `${options.fallbackMessage} (${error.message})`;
    }
    return status ? `${options.fallbackMessage} (HTTP ${status})` : options.fallbackMessage;
  }

  if (status) {
    return `Request failed with HTTP ${status}.`;
  }

  return error.message || 'Network request failed.';
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
