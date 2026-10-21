import { describe, expect, it } from 'vitest';

import { FMClientError } from '../../src/services/errors';
import { normalizeError } from '../../src/utils/normalizeError';

describe('normalizeError', () => {
  it('maps FileMaker 401 payload to auth error', () => {
    const error = normalizeError({
      isAxiosError: true,
      message: 'Unauthorized',
      response: {
        status: 401,
        data: {
          messages: [{ code: '952', message: 'Invalid token' }]
        },
        headers: {
          authorization: 'Bearer secret-token'
        }
      }
    });

    expect(error.kind).toBe('auth');
    expect(error.code).toBe('952');
    expect(error.message).toContain('Invalid token');
    expect(error.safeHeaders?.authorization).toBe('***');
  });

  it('maps timeout to timeout kind with retryable true', () => {
    const error = normalizeError({
      isAxiosError: true,
      code: 'ECONNABORTED',
      message: 'timeout of 1000ms exceeded',
      response: {
        status: 504,
        data: 'gateway timeout'
      }
    });

    expect(error.kind).toBe('timeout');
    expect(error.isRetryable).toBe(true);
    expect(error.status).toBe(504);
  });

  it('maps abort errors to cancellation', () => {
    const error = normalizeError(new DOMException('Aborted', 'AbortError'));

    expect(error.kind).toBe('cancellation');
    expect(error.isRetryable).toBe(false);
  });

  it('maps FMClientError preserving status and details', () => {
    const source = new FMClientError('Boom', {
      status: 500,
      code: '500',
      details: { token: 'secret' }
    });

    const error = normalizeError(source);
    expect(error.kind).toBe('server');
    expect(error.status).toBe(500);
    expect(error.code).toBe('500');
    expect(error.details).toEqual({ token: 'secret' });
  });

  it('applies fallback message and request metadata', () => {
    const error = normalizeError(
      {
        isAxiosError: true,
        message: 'Network Error',
        response: undefined
      },
      {
        fallbackMessage: 'Could not complete request.',
        requestId: 'req-1',
        endpoint: 'GET /layouts'
      }
    );

    expect(error.message).toContain('Could not complete request.');
    expect(error.requestId).toBe('req-1');
    expect(error.endpoint).toBe('GET /layouts');
  });
});

it.each(['POST', 'PATCH', 'DELETE', 'GET script'])('warns against repeating an uncertain %s after a 1.5 second timeout', (operation) => {
  const method = operation === 'GET script' ? 'GET' : operation;
  const path = operation === 'GET script' ? '/layouts/Contacts/script/Slow' : '/layouts/Contacts/records';
  const error = normalizeError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout of 1500ms exceeded', config: { method, url: `https://fm.example${path}`, timeout: 1500 } });
  expect(error.message).toContain('after 1.5 s');
  expect(error.message).toContain('The change may have been applied. Check the record before trying again.');
  expect(error.isRetryable).toBe(false);
});

it('keeps a timed-out read retryable and shows a decimal', () => {
  const error = normalizeError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout', config: { method: 'GET', url: 'https://fm.example/layouts', timeout: 2000 } });
  expect(error.message).toContain('after 2.0 s');
  expect(error.message).not.toContain('change may');
  expect(error.isRetryable).toBe(true);
});

it.each([413, 429])('gives a next step for HTTP %s, including Retry-After', (status) => {
  const error = normalizeError({ isAxiosError: true, message: 'Error', response: { status, data: '<html>Error</html>', headers: { 'retry-after': '600' } } });
  expect(error.message).toMatch(status === 413 ? /smaller|fewer/i : /600.*second|second.*600/i);
  if (status === 429) expect(error.message).toMatch(/wait/i);
});

it('does not retry a timed-out read that runs an attached script', () => {
  const error = normalizeError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout', config: { method: 'GET', url: 'https://fm.example/layouts/C/records', params: { script: 'Slow' }, timeout: 1500 } });
  expect(error.isRetryable).toBe(false);
  expect(error.message).toContain('The change may have been applied.');
});

it.each([500, 502, 504])('gives server advice for HTTP %s without a FileMaker code', (status) => {
  const error = normalizeError({ isAxiosError: true, message: 'Error', response: { status, data: '<html>Failure</html>' } });
  expect(error.message).toMatch(/try again/i);
  expect(error.message).toContain('Admin Console');
});

it('honors Retry-After even with a FileMaker-style error envelope', () => {
  const retryAfter = 'Wed, 21 Oct 2026 20:00:00 GMT';
  const error = normalizeError({ isAxiosError: true, message: 'Error', response: { status: 429, data: { messages: [{ code: '-1', message: 'Rate limit' }] }, headers: { 'Retry-After': retryAfter } } });
  expect(error.message).toContain(`Wait before trying again: Retry-After is ${retryAfter}`);
});
