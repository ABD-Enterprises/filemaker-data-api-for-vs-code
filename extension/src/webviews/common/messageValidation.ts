import type { WebviewMessageEnvelope } from '../../types/webviewMessages';

/** Default upper bound on the JSON-serialized size of a single webview message. */
export const DEFAULT_MAX_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Default upper bound on the length of a single string field. Kept generous to allow find queries. */
export const DEFAULT_MAX_STRING_FIELD_LENGTH = 64 * 1024; // 64 KiB

/** Default upper bound on the depth of a message object. Anti-DoS guard. */
export const DEFAULT_MAX_DEPTH = 16;

export interface MessageValidationOptions {
  maxBytes?: number;
  maxDepth?: number;
}

export interface MessageValidationFailure {
  ok: false;
  reason:
    | 'not-object'
    | 'too-large'
    | 'too-deep'
    | 'prototype-pollution'
    | 'circular'
    | 'invalid-json';
  detail?: string;
}

export interface MessageValidationSuccess {
  ok: true;
  record: Record<string, unknown>;
}

export type MessageValidationResult = MessageValidationSuccess | MessageValidationFailure;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Comprehensive structural validator for inbound webview messages. Returns a
 * tagged result so callers don't throw and don't leak internal state on bad
 * input. Pair with hasMessageType / getStringField / etc to extract typed
 * fields after validation succeeds.
 */
export function validateEnvelope(
  value: unknown,
  options?: MessageValidationOptions
): MessageValidationResult {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not-object' };
  }

  // Size check uses JSON.stringify; circular references throw.
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof TypeError && /circular/i.test(err.message) ? 'circular' : 'invalid-json',
      detail: err instanceof Error ? err.message : undefined
    };
  }

  if (typeof serialized !== 'string') {
    return { ok: false, reason: 'invalid-json' };
  }

  const byteLen = Buffer.byteLength(serialized, 'utf8');
  if (byteLen > maxBytes) {
    return { ok: false, reason: 'too-large', detail: `${byteLen} > ${maxBytes}` };
  }

  const depthCheck = checkDepthAndKeys(value, 0, maxDepth);
  if (depthCheck) {
    return depthCheck;
  }

  return { ok: true, record: value as Record<string, unknown> };
}

function checkDepthAndKeys(
  value: unknown,
  depth: number,
  maxDepth: number
): MessageValidationFailure | undefined {
  if (depth > maxDepth) {
    return { ok: false, reason: 'too-deep', detail: `depth ${depth} > ${maxDepth}` };
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const sub = checkDepthAndKeys(item, depth + 1, maxDepth);
      if (sub) return sub;
    }
    return undefined;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, reason: 'prototype-pollution', detail: `disallowed key: ${key}` };
    }
    const sub = checkDepthAndKeys(
      (value as Record<string, unknown>)[key],
      depth + 1,
      maxDepth
    );
    if (sub) return sub;
  }
  return undefined;
}

export function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function hasMessageType<TType extends string>(
  value: unknown,
  type: TType
): value is WebviewMessageEnvelope<TType> {
  const record = toRecord(value);
  return record?.type === type;
}

export function getStringField(
  value: Record<string, unknown>,
  field: string,
  options?: { maxLength?: number }
): string | undefined {
  const raw = value[field];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const limit = options?.maxLength ?? DEFAULT_MAX_STRING_FIELD_LENGTH;
  if (raw.length > limit) {
    return undefined;
  }
  return raw;
}

export function getOptionalBooleanField(
  value: Record<string, unknown>,
  field: string
): boolean | undefined {
  const raw = value[field];
  return typeof raw === 'boolean' ? raw : undefined;
}

export function getOptionalNumberField(
  value: Record<string, unknown>,
  field: string,
  options?: { min?: number; max?: number }
): number | undefined {
  const raw = value[field];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return undefined;
  }
  if (options?.min !== undefined && raw < options.min) return undefined;
  if (options?.max !== undefined && raw > options.max) return undefined;
  return raw;
}
