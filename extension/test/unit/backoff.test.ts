import { beforeEach, describe, expect, it, vi } from 'vitest';

import { computeBackoffDelayMs, retryWithBackoff } from '../../src/utils/backoff';

const NO_JITTER = { jitter: 0 } as const;

describe('computeBackoffDelayMs', () => {
  it('returns capped exponential delays without jitter', () => {
    const policy = { maxRetries: 5, initialMs: 1000, maxMs: 8000, multiplier: 2, ...NO_JITTER };
    expect(computeBackoffDelayMs(0, policy)).toBe(1000);
    expect(computeBackoffDelayMs(1, policy)).toBe(2000);
    expect(computeBackoffDelayMs(2, policy)).toBe(4000);
    expect(computeBackoffDelayMs(3, policy)).toBe(8000);
    expect(computeBackoffDelayMs(4, policy)).toBe(8000); // capped
    expect(computeBackoffDelayMs(20, policy)).toBe(8000); // still capped
  });

  it('applies symmetric jitter when configured', () => {
    const policy = { maxRetries: 3, initialMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0.5 };
    // random()=0 → -50%; random()=0.5 → 0; random()=1 → +50%
    expect(computeBackoffDelayMs(0, policy, () => 0)).toBe(500);
    expect(computeBackoffDelayMs(0, policy, () => 0.5)).toBe(1000);
    expect(computeBackoffDelayMs(0, policy, () => 1)).toBe(1500);
  });

  it('clamps to non-negative for any random value', () => {
    const policy = { maxRetries: 3, initialMs: 100, maxMs: 1000, multiplier: 2, jitter: 5 };
    expect(computeBackoffDelayMs(0, policy, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('retryWithBackoff', () => {
  const policy = { maxRetries: 3, initialMs: 10, maxMs: 100, multiplier: 2, ...NO_JITTER };
  let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
  const random = () => 0.5;

  beforeEach(() => {
    sleep = vi.fn(async () => {});
  });

  it('returns the value on first success without sleeping', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await retryWithBackoff(fn, policy, { sleep, random });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries until success, sleeping with backoff between attempts', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'eventual';
    });
    const onRetry = vi.fn();
    const result = await retryWithBackoff(fn, policy, { sleep, random, onRetry });
    expect(result).toBe('eventual');
    expect(fn).toHaveBeenCalledTimes(3);
    // 2 sleeps before the third (successful) attempt
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(10); // attempt 0 -> 10ms
    expect(sleep.mock.calls[1]?.[0]).toBe(20); // attempt 1 -> 20ms
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 0, delayMs: 10 });
  });

  it('throws the last error after exhausting retries', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always fails');
    });
    await expect(retryWithBackoff(fn, policy, { sleep, random })).rejects.toThrow('always fails');
    // maxRetries=3 -> 4 total attempts
    expect(fn).toHaveBeenCalledTimes(4);
    // 3 sleeps between 4 attempts
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('honors shouldRetry to bail early on non-retryable errors', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fatal: 401 Unauthorized');
    });
    await expect(
      retryWithBackoff(fn, policy, {
        sleep,
        random,
        shouldRetry: (err) => !/401/.test(String(err))
      })
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
