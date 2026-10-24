import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../../src/performance/circuitBreaker';

describe('CircuitBreaker', () => {
  it('opens after failure threshold and recovers in half-open mode', () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      openMs: 100,
      halfOpenSuccessThreshold: 1
    });

    breaker.recordFailure(0);
    breaker.recordFailure(1);

    expect(breaker.getState(1)).toBe('open');
    expect(breaker.canRequest(50)).toBe(false);
    expect(breaker.canRequest(120)).toBe(true);
    expect(breaker.getState(120)).toBe('half-open');

    breaker.recordSuccess(120);
    expect(breaker.getState(120)).toBe('closed');
  });

  it('re-opens when half-open request fails', () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      openMs: 50,
      halfOpenSuccessThreshold: 2
    });

    breaker.recordFailure(0);
    expect(breaker.getState(0)).toBe('open');

    expect(breaker.canRequest(120)).toBe(true);
    expect(breaker.getState(120)).toBe('half-open');

    breaker.recordFailure(120);
    expect(breaker.getState(120)).toBe('open');
  });
});
