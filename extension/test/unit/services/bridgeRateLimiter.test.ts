import { beforeEach, describe, expect, it } from 'vitest';

import {
  BridgeRateLimiter,
  normalizeBridgeRateLimitConfig
} from '../../../src/services/bridgeRateLimiter';

describe('BridgeRateLimiter', () => {
  let now: number;
  const clock = (): number => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('allows requests up to the burst capacity instantly', () => {
    const limiter = new BridgeRateLimiter({ perSecond: 10, burst: 3, budget: 100 }, clock);
    expect(limiter.tryConsume().ok).toBe(true);
    expect(limiter.tryConsume().ok).toBe(true);
    expect(limiter.tryConsume().ok).toBe(true);
    expect(limiter.tryConsume().ok).toBe(false);
  });

  it('returns retryAfterMs aligned with the refill rate when throttled', () => {
    const limiter = new BridgeRateLimiter({ perSecond: 10, burst: 2, budget: 100 }, clock);
    limiter.tryConsume();
    limiter.tryConsume();
    const denied = limiter.tryConsume();
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe('rate');
    // 10/sec = 100ms per token; retryAfterMs should be around 100ms
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(50);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(150);
  });

  it('refills tokens over time so subsequent requests succeed', () => {
    const limiter = new BridgeRateLimiter({ perSecond: 10, burst: 2, budget: 100 }, clock);
    limiter.tryConsume();
    limiter.tryConsume();
    expect(limiter.tryConsume().ok).toBe(false);

    // 200ms = 2 tokens refilled
    now += 200;
    expect(limiter.tryConsume().ok).toBe(true);
    expect(limiter.tryConsume().ok).toBe(true);
    expect(limiter.tryConsume().ok).toBe(false);
  });

  it('caps refill at the burst capacity (no infinite accumulation)', () => {
    const limiter = new BridgeRateLimiter({ perSecond: 10, burst: 5, budget: 100 }, clock);
    // Idle for 10 seconds → would refill 100 tokens, but cap is 5
    now += 10_000;
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.tryConsume().ok).toBe(true);
    }
    expect(limiter.tryConsume().ok).toBe(false);
  });

  it('refuses requests once the hard budget is exhausted', () => {
    const limiter = new BridgeRateLimiter({ perSecond: 1000, burst: 100, budget: 3 }, clock);
    expect(limiter.tryConsume().ok).toBe(true);
    expect(limiter.tryConsume().ok).toBe(true);
    expect(limiter.tryConsume().ok).toBe(true);
    const denied = limiter.tryConsume();
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe('budget');
    expect(denied.retryAfterMs).toBe(0);
  });

  it('reset() restores the burst capacity and clears the budget counter', () => {
    const limiter = new BridgeRateLimiter({ perSecond: 10, burst: 2, budget: 3 }, clock);
    limiter.tryConsume();
    limiter.tryConsume();
    limiter.tryConsume();
    expect(limiter.tryConsume().reason).toBe('budget');

    limiter.reset();
    expect(limiter.tryConsume().ok).toBe(true);
    expect(limiter.tryConsume().ok).toBe(true);
  });

  it('throws on invalid config (non-positive numbers)', () => {
    expect(() => new BridgeRateLimiter({ perSecond: 0, burst: 1, budget: 1 })).toThrow();
    expect(() => new BridgeRateLimiter({ perSecond: 1, burst: 0, budget: 1 })).toThrow();
    expect(() => new BridgeRateLimiter({ perSecond: 1, burst: 1, budget: 0 })).toThrow();
  });

  it('snapshot reports current counters', () => {
    const limiter = new BridgeRateLimiter({ perSecond: 10, burst: 5, budget: 10 }, clock);
    limiter.tryConsume();
    limiter.tryConsume();
    const snap = limiter.snapshot();
    expect(snap.tokens).toBeLessThanOrEqual(3);
    expect(snap.consumed).toBe(2);
    expect(snap.budgetRemaining).toBe(8);
  });
});

describe('normalizeBridgeRateLimitConfig', () => {
  it('falls back to defaults for invalid values', () => {
    expect(normalizeBridgeRateLimitConfig({ perSecond: 0 })).toMatchObject({ perSecond: 20 });
    expect(normalizeBridgeRateLimitConfig({ burst: -1 })).toMatchObject({ burst: 60 });
    expect(normalizeBridgeRateLimitConfig({ budget: Number.NaN })).toMatchObject({ budget: 10_000 });
    expect(normalizeBridgeRateLimitConfig(undefined)).toEqual({
      perSecond: 20,
      burst: 60,
      budget: 10_000
    });
  });

  it('rounds and accepts valid values', () => {
    expect(normalizeBridgeRateLimitConfig({ perSecond: 5.7, burst: 30, budget: 500 })).toEqual({
      perSecond: 5,
      burst: 30,
      budget: 500
    });
  });
});
