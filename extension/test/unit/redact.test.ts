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
      'X-Test': 'ok'
    });

    expect(headers?.Authorization).toBe('***');
    expect(headers?.['X-Test']).toBe('ok');
  });
});

describe('redact: places a secret used to slip through', () => {
  it('redacts the session token in a DELETE /sessions/<token> path', () => {
    expect(redactString('DELETE /sessions/abcDEF123-token')).toBe('DELETE /sessions/***');
    expect(redactString('DELETE /sessions/{token}')).toBe('DELETE /sessions/{token}');
    expect(redactString('POST /sessions')).toBe('POST /sessions');
  });

  it('redacts access tokens and similar query parameters', () => {
    const text = redactString('GET /x?access_token=abc&page=2&sessionToken=def&api_key=ghi&sig=jkl');
    expect(text).toBe('GET /x?access_token=***&page=2&sessionToken=***&api_key=***&sig=***');
  });

  it('redacts secret JSON keys whatever their prefix or suffix', () => {
    const json = JSON.stringify({ sessionToken: 'tok1', access_token: 'tok2', proxyApiKey: 'k', clientSecret: 's', name: 'ok' });
    const text = redactString(json);
    expect(text).not.toMatch(/tok1|tok2|"k"|"s"/);
    expect(text).toContain('"name":"ok"');
  });

  it('redacts credentials embedded in a URL', () => {
    expect(redactString('failed https://user:p%40ss@fm.example.com/fmi/data')).toBe(
      'failed https://***@fm.example.com/fmi/data'
    );
    expect(redactString('https://fm.example.com/fmi')).toBe('https://fm.example.com/fmi');
  });
});
