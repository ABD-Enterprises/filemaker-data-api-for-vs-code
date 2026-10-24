import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';

import { parseDataApiEnvelope } from '../../src/services/responseGuard';
import { normalizeError } from '../../src/utils/normalizeError';
import { plainTextPreview } from '../../src/utils/plainText';

const BUDGET_MS = 250;
const timed = <T>(action: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = action();
  return { value, ms: performance.now() - start };
};

const hostile: Array<[string, string]> = [
  ['a megabyte of "<"', '<'.repeat(1_000_000)],
  ['a megabyte of "<a" with no ">"', '<a'.repeat(500_000)],
  ['nested open tags', '<div '.repeat(200_000)],
  ['an unterminated script', `<script>${'x'.repeat(1_000_000)}`],
  ['a megabyte of ">"', '>'.repeat(1_000_000)],
  ['many tiny tags', '<b>'.repeat(300_000)]
];

describe('stripping tags from a server-controlled body', () => {
  it.each(hostile)('plainTextPreview finishes quickly on %s', (_label, body) => {
    const { value, ms } = timed(() => plainTextPreview(body, 300));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.length).toBeLessThanOrEqual(301);
  });

  it.each(hostile)('the error details and the not-the-Data-API error stay fast on %s', (_label, body) => {
    const config = { headers: new AxiosHeaders(), url: 'https://fm.example.com/x' };
    const error = new AxiosError('x', 'ERR_BAD_RESPONSE', config as never, {}, { status: 502, statusText: '', headers: {}, config: config as never, data: body } as never);
    const normalized = timed(() => normalizeError(error, { fallbackMessage: 'x' }));
    expect(normalized.ms).toBeLessThan(BUDGET_MS);
    expect(String(normalized.value.details).length).toBeLessThanOrEqual(301);

    const guarded = timed(() => {
      try {
        parseDataApiEnvelope({ status: 200, data: body, headers: {} });
      } catch (caught) {
        return caught as { details?: { bodyStart?: string } };
      }
      return undefined;
    });
    expect(guarded.ms).toBeLessThan(BUDGET_MS);
    expect((guarded.value?.details?.bodyStart ?? '').length).toBeLessThanOrEqual(201);
  });

  it('still produces readable text from a normal gateway page', () => {
    const page = '<html><head><style>p{}</style><script>var x=1</script></head><body><h1>502 Bad Gateway</h1><p>upstream&nbsp;down</p></body></html>';
    expect(plainTextPreview(page, 300)).toBe('502 Bad Gateway upstream&nbsp;down');
  });
});
