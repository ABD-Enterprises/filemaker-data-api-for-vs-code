import { describe, expect, it } from 'vitest';

import { redactHeaders, redactString, redactValue } from '../../src/utils/redact';

describe('redact', () => {
  it('redacts bearer/basic tokens in strings', () => {
    const value = redactString('Authorization: Bearer abc123 Basic qwerty');
    expect(value).toContain('Bearer ***');
    expect(value).toContain('Basic ***');
    expect(value).not.toContain('abc123');
  });

  it('redacts known secret keys in objects', () => {
    const value = redactValue({
      password: 'p@ss',
      nested: {
        token: 'abc',
        ok: 'value'
      }
    }) as Record<string, unknown>;

    expect(value.password).toBe('***');
    const nested = value.nested as Record<string, unknown>;
    expect(nested.token).toBe('***');
    expect(nested.ok).toBe('value');
  });

  it('redacts authorization headers', () => {
    const headers = redactHeaders({
      Authorization: 'Bearer abc',
      'set-cookie': 'session=abc',
      'X-Test': 'ok'
    });

    expect(headers?.Authorization).toBe('***');
    expect(headers?.['set-cookie']).toBe('***');
    expect(headers?.['X-Test']).toBe('ok');
  });
});
