import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';

import { normalizeError } from '../../src/utils/normalizeError';

function httpError(status: number, data: unknown, headers: Record<string, string> = {}): AxiosError {
  const config = { headers: new AxiosHeaders(), url: 'https://fm.example.com/fmi/data/vLatest/databases/Sales/sessions' };
  return new AxiosError('failed', 'ERR_BAD_RESPONSE', config as never, {}, {
    status,
    statusText: '',
    headers,
    config: config as never,
    data
  } as never);
}

const fm = (code: string, message: string) => ({ messages: [{ code, message }], response: {} });

describe('error messages and retry decisions', () => {
  it('explains 802 (no fmrest privilege / closed file) and never retries a FileMaker business error', () => {
    const normalized = normalizeError(httpError(500, fm('802', 'Unable to open file')), { fallbackMessage: 'x' });
    expect(normalized.message).toMatch(/\[802\].*fmrest/s);
    expect(normalized.fmCategory).toBe('config');
    expect(normalized.isRetryable).toBe(false);
  });

  it('retries 500 only when there is no FileMaker answer, or the code is one that clears', () => {
    expect(normalizeError(httpError(500, '<html>oops</html>'), { fallbackMessage: 'x' }).isRetryable).toBe(true);
    expect(normalizeError(httpError(500, fm('101', 'Record is missing')), { fallbackMessage: 'x' }).isRetryable).toBe(false);
    expect(normalizeError(httpError(500, fm('301', 'Record in use')), { fallbackMessage: 'x' }).isRetryable).toBe(true);
    expect(normalizeError(httpError(500, fm('956', 'Maximum number of sessions')), { fallbackMessage: 'x' }).isRetryable).toBe(true);
    expect(normalizeError(httpError(502, '<html>bad gateway</html>'), { fallbackMessage: 'x' }).isRetryable).toBe(true);
  });

  it('honours 429 with Retry-After', () => {
    const normalized = normalizeError(httpError(429, '<html>slow down</html>', { 'retry-after': '2' }), { fallbackMessage: 'x' });
    expect(normalized.isRetryable).toBe(true);
    expect(normalized.retryAfterMs).toBe(2000);
    expect(normalized.message).toMatch(/too many requests/i);
  });

  it('says a privilege problem is for the administrator, not the profile', () => {
    expect(normalizeError(httpError(403, ''), { fallbackMessage: 'x' }).message).toMatch(/administrator.*will not help/s);
    const code = normalizeError(httpError(500, fm('9', 'Insufficient privileges')), { fallbackMessage: 'x' });
    expect(code.fmCategory).toBe('privilege');
    expect(code.message).toMatch(/privilege set/);
  });

  it('explains a bare 404 as wrong address / Data API off, not as unsupported metadata', () => {
    const message = normalizeError(httpError(404, '<html>Not Found</html>'), { fallbackMessage: 'x' }).message;
    expect(message).toMatch(/Server URL.*API base path.*Data API is enabled/s);
  });

  it('keeps only a short plain-text version of a gateway page in the details', () => {
    const page = `<html><head><style>p{}</style></head><body><h1>502</h1><p>upstream fm-internal-7.corp.example:16000 refused</p>${'x'.repeat(2000)}</body></html>`;
    const details = normalizeError(httpError(502, page), { fallbackMessage: 'x' }).details as string;
    expect(details).not.toContain('<');
    expect(details.length).toBeLessThanOrEqual(301);
  });

  it('turns FileMaker credential codes into authentication errors whatever the HTTP status', () => {
    for (const code of ['210', '211', '212', '214']) {
      const normalized = normalizeError(httpError(500, fm(code, 'x')), { fallbackMessage: 'x' });
      expect(normalized.kind).toBe('auth');
      expect(normalized.fmCategory).toBe('credentials');
      expect(normalized.isRetryable).toBe(false);
    }
  });

  it('names where a redirect pointed (scheme and host only) and refuses an https-to-http downgrade', () => {
    const redirect = (from: string, location: string) => {
      const config = { headers: new AxiosHeaders(), url: from };
      return new AxiosError('x', 'ERR_BAD_RESPONSE', config as never, {}, {
        status: 301, statusText: '', headers: { location }, config: config as never, data: ''
      } as never);
    };
    const downgrade = normalizeError(redirect('https://fm.example.com/a', 'http://fm.example.com/a?token=SECRET'), { fallbackMessage: 'x' }).message;
    expect(downgrade).toMatch(/https to plain http/);
    expect(downgrade).not.toContain('SECRET');
    const elsewhere = normalizeError(redirect('https://fm.example.com/a', 'https://evil.example.net/p?x=1'), { fallbackMessage: 'x' }).message;
    expect(elsewhere).toContain('https://evil.example.net');
    expect(elsewhere).not.toContain('x=1');
    expect(normalizeError(redirect('http://fm.example.com/a', 'https://fm.example.com/a'), { fallbackMessage: 'x' }).message).toMatch(/different address|same server/);
  });

  it('says Claris ID sign-in is not supported when a rejected login is against a FileMaker Cloud host', () => {
    const at = (url: string, status: number, data: unknown) => {
      const config = { headers: new AxiosHeaders(), url };
      return new AxiosError('x', 'ERR_BAD_REQUEST', config as never, {}, { status, statusText: '', headers: {}, config: config as never, data } as never);
    };
    const cloud = normalizeError(
      at('https://myhost.account.filemaker-cloud.com/fmi/data/vLatest/databases/D/sessions', 401, fm('212', 'Invalid user account and/or password')),
      { fallbackMessage: 'x' }
    ).message;
    expect(cloud).toMatch(/FileMaker Cloud normally uses Claris ID sign-in, which this extension does not support/);
    // Not an overclaim: nobody has verified that a name and password never work on a tenant.
    expect(cloud).toContain('may not be accepted by your Cloud tenant');
    expect(cloud).toContain('Ask Claris or your administrator');
    expect(cloud).not.toMatch(/cannot work|even if they are correct/);
    const onPremise = normalizeError(
      at('https://fm.example.com/fmi/data/vLatest/databases/D/sessions', 401, fm('212', 'Invalid user account and/or password')),
      { fallbackMessage: 'x' }
    ).message;
    expect(onPremise).not.toMatch(/Cloud/);
    // Only for a rejected login, not for, say, a missing layout.
    const other = normalizeError(
      at('https://myhost.account.filemaker-cloud.com/fmi/data/vLatest/databases/D/layouts/X', 500, fm('105', 'Layout is missing')),
      { fallbackMessage: 'x' }
    ).message;
    expect(other).not.toMatch(/Claris ID/);
  });
});
