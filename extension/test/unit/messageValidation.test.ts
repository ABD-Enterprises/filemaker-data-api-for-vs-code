import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_STRING_FIELD_LENGTH,
  getOptionalBooleanField,
  getOptionalNumberField,
  getStringField,
  hasMessageType,
  toRecord,
  validateEnvelope
} from '../../src/webviews/common/messageValidation';

describe('messageValidation: type guards', () => {
  it('guards object records', () => {
    expect(toRecord(null)).toBeUndefined();
    expect(toRecord([])).toBeUndefined();
    expect(toRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it('checks message type', () => {
    expect(hasMessageType({ type: 'ready' }, 'ready')).toBe(true);
    expect(hasMessageType({ type: 'other' }, 'ready')).toBe(false);
  });

  it('reads typed fields', () => {
    const record = { a: 'x', b: true, c: 42 };
    expect(getStringField(record, 'a')).toBe('x');
    expect(getOptionalBooleanField(record, 'b')).toBe(true);
    expect(getOptionalNumberField(record, 'c')).toBe(42);
    expect(getOptionalNumberField(record, 'a')).toBeUndefined();
  });

  it('rejects oversized strings via getStringField', () => {
    const record = { big: 'x'.repeat(DEFAULT_MAX_STRING_FIELD_LENGTH + 1) };
    expect(getStringField(record, 'big')).toBeUndefined();
    expect(getStringField(record, 'big', { maxLength: 10 })).toBeUndefined();
    expect(getStringField({ small: 'hello' }, 'small', { maxLength: 10 })).toBe('hello');
  });

  it('enforces numeric range via getOptionalNumberField', () => {
    const record = { n: 100 };
    expect(getOptionalNumberField(record, 'n', { min: 0, max: 200 })).toBe(100);
    expect(getOptionalNumberField(record, 'n', { min: 0, max: 50 })).toBeUndefined();
    expect(getOptionalNumberField(record, 'n', { min: 200, max: 1000 })).toBeUndefined();
    expect(getOptionalNumberField({ n: NaN }, 'n')).toBeUndefined();
    expect(getOptionalNumberField({ n: Infinity }, 'n')).toBeUndefined();
  });
});

describe('validateEnvelope', () => {
  it('rejects non-objects', () => {
    expect(validateEnvelope(null)).toEqual({ ok: false, reason: 'not-object' });
    expect(validateEnvelope(undefined)).toEqual({ ok: false, reason: 'not-object' });
    expect(validateEnvelope(42)).toEqual({ ok: false, reason: 'not-object' });
    expect(validateEnvelope('string')).toEqual({ ok: false, reason: 'not-object' });
    expect(validateEnvelope([])).toEqual({ ok: false, reason: 'not-object' });
  });

  it('accepts a well-formed message', () => {
    const result = validateEnvelope({ type: 'ready', payload: { layout: 'Contacts' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.type).toBe('ready');
    }
  });

  it('rejects messages exceeding the byte limit', () => {
    const huge = { type: 'paste', body: 'x'.repeat(DEFAULT_MAX_MESSAGE_BYTES + 100) };
    const result = validateEnvelope(huge);
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('respects custom maxBytes', () => {
    const result = validateEnvelope({ type: 'ready', body: 'hello world' }, { maxBytes: 5 });
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('rejects deeply nested objects', () => {
    let nested: Record<string, unknown> = { type: 'ready' };
    for (let i = 0; i < 25; i += 1) {
      nested = { child: nested };
    }
    const result = validateEnvelope(nested, { maxDepth: 16 });
    expect(result).toMatchObject({ ok: false, reason: 'too-deep' });
  });

  it('rejects __proto__ key (prototype pollution attempt)', () => {
    // Note: object literal { __proto__: ... } sets the prototype directly;
    // use Object.defineProperty / JSON parse to inject it as an own property.
    const malicious = JSON.parse('{"type":"ready","__proto__":{"polluted":true}}');
    const result = validateEnvelope(malicious);
    expect(result).toMatchObject({ ok: false, reason: 'prototype-pollution' });
  });

  it('rejects nested constructor key', () => {
    const malicious = { type: 'ready', payload: { constructor: { evil: true } } };
    const result = validateEnvelope(malicious);
    expect(result).toMatchObject({ ok: false, reason: 'prototype-pollution' });
  });

  it('rejects circular references', () => {
    const circ: Record<string, unknown> = { type: 'ready' };
    circ.self = circ;
    const result = validateEnvelope(circ);
    expect(result).toMatchObject({ ok: false, reason: 'circular' });
  });

  it('walks arrays for forbidden keys', () => {
    // A `__proto__` key in an object literal sets the prototype rather than an
    // own property, so it cannot exercise the array walk. Parse JSON instead,
    // which produces a genuine own `__proto__` property at an array element.
    const withInjected = JSON.parse(
      '{"type":"ready","items":[{"ok":true},{"__proto__":{"polluted":true}}]}'
    );
    const result = validateEnvelope(withInjected);
    expect(result).toMatchObject({ ok: false, reason: 'prototype-pollution' });
    // Control: the same shape without the forbidden key validates cleanly.
    const safe = validateEnvelope({ type: 'ready', items: [{ ok: true }] });
    expect(safe.ok).toBe(true);
  });
});
