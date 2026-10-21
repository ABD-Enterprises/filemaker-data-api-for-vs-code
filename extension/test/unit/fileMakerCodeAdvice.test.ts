import { describe, expect, it } from 'vitest';
import { getFileMakerErrorInfo } from '../../src/utils/fileMakerCodes';
import { normalizeError } from '../../src/utils/normalizeError';

// FileMaker codes in scripts/mock/ENDPOINTS.md's failure and named-fault tables.
// HTTP 500/502/504 are gateway failures only when there is no FileMaker code.
const catalogue = [-1, 3, 9, 100, 101, 102, 104, 105, 200, 201, 205, 210, 211, 212, 214, 301, 306, 400, 401, 500, 502, 504, 506, 509, 802, 952, 956, 960, 1633];

describe('failure catalogue next steps', () => {
  it.each(catalogue)('gives plain advice for FileMaker code %s', (code) => {
    const info = getFileMakerErrorInfo(code);
    expect(info?.advice).toMatch(/check|ask|try|reload|enter|choose|wait|sign|refresh|change|use|correct/i);
    const error = normalizeError({ isAxiosError: true, message: 'Failure', response: { status: 500, data: { messages: [{ code: String(code), message: info?.meaning }] } } });
    expect(error.message).toContain(info!.advice);
  });
  it('categorizes 1633 and distinguishes validation codes from HTTP gateway errors', () => {
    expect(getFileMakerErrorInfo(1633)?.category).toBe('transient');
    expect(getFileMakerErrorInfo(500)?.advice).toMatch(/date/i);
    expect(getFileMakerErrorInfo(502)?.advice).toMatch(/number/i);
    expect(getFileMakerErrorInfo(504)?.advice).toMatch(/unique|different/i);
  });
});
