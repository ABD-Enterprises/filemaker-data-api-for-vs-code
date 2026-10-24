import { describe, expect, it } from 'vitest';

import { AdaptiveConcurrency } from '../../src/performance/adaptiveConcurrency';

describe('AdaptiveConcurrency', () => {
  it('increases concurrency after sustained low latency', () => {
    const controller = new AdaptiveConcurrency({
      initial: 2,
      min: 1,
      max: 6,
      targetLatencyMs: 500,
      growEvery: 3
    });

    controller.recordSuccess(200);
    controller.recordSuccess(220);
    controller.recordSuccess(210);

    expect(controller.getLimit()).toBeGreaterThan(2);
  });

  it('reduces concurrency on failures', () => {
    const controller = new AdaptiveConcurrency({
      initial: 5,
      min: 1,
      max: 8,
      targetLatencyMs: 600
    });

    controller.recordFailure(500);
    controller.recordFailure(500);

    expect(controller.getLimit()).toBeLessThan(5);
  });

  it('returns exponential backoff delay', () => {
    const controller = new AdaptiveConcurrency({
      initial: 2,
      min: 1,
      max: 6
    });

    const first = controller.getBackoffDelayMs(0, 429);
    const second = controller.getBackoffDelayMs(1, 429);

    expect(second).toBeGreaterThan(first);
  });
});
