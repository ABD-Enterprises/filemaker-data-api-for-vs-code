import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../../../src/performance/circuitBreaker';
import {
  CircuitBreakerRegistry,
  renderCircuitBreakerStatus
} from '../../../src/performance/circuitBreakerRegistry';

function createBreaker(): { breaker: CircuitBreaker; registry: CircuitBreakerRegistry } {
  const registry = new CircuitBreakerRegistry();
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    openMs: 1_000,
    onTransition: (t) => registry.recordTransition('test', t)
  });
  registry.register('test', breaker, 0);
  return { breaker, registry };
}

describe('CircuitBreakerRegistry', () => {
  it('returns empty list when no breakers registered', () => {
    const registry = new CircuitBreakerRegistry();
    expect(registry.list()).toEqual([]);
  });

  it('records transitions when the breaker trips', () => {
    const { breaker, registry } = createBreaker();
    breaker.recordFailure(1_000);
    breaker.recordFailure(1_001);
    breaker.recordFailure(1_002);
    const entries = registry.list(1_500);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.diagnostics.state).toBe('open');
    expect(entries[0]?.transitions).toHaveLength(1);
    expect(entries[0]?.transitions[0]?.reason).toBe('failure-threshold');
  });

  it('records auto-half-open transition when the open window elapses', () => {
    const { breaker, registry } = createBreaker();
    breaker.recordFailure(1_000);
    breaker.recordFailure(1_001);
    breaker.recordFailure(1_002);

    // Past the openMs window
    breaker.getState(3_000);
    const entries = registry.list(3_000);
    expect(entries[0]?.diagnostics.state).toBe('half-open');
    expect(entries[0]?.transitions.map((t) => t.to)).toEqual(['open', 'half-open']);
  });

  it('replaces prior entry on duplicate registration (last writer wins)', () => {
    const registry = new CircuitBreakerRegistry();
    const a = new CircuitBreaker({ failureThreshold: 1 });
    const b = new CircuitBreaker({ failureThreshold: 1 });
    registry.register('shared', a, 0);
    registry.register('shared', b, 100);
    expect(registry.size()).toBe(1);
    expect(registry.list(200)[0]?.registeredAt).toBe(100);
  });

  it('caps recorded transitions at 25', () => {
    const registry = new CircuitBreakerRegistry();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 100 });
    registry.register('flapping', breaker, 0);
    for (let i = 0; i < 50; i += 1) {
      registry.recordTransition('flapping', {
        from: 'closed',
        to: 'open',
        at: i,
        reason: 'failure-threshold'
      });
    }
    const entries = registry.list();
    expect(entries[0]?.transitions.length).toBe(25);
    // Most-recent are kept; oldest 25 dropped
    expect(entries[0]?.transitions[0]?.at).toBe(25);
    expect(entries[0]?.transitions[24]?.at).toBe(49);
  });

  it('unregister removes the breaker', () => {
    const { registry } = createBreaker();
    registry.unregister('test');
    expect(registry.size()).toBe(0);
  });
});

describe('renderCircuitBreakerStatus', () => {
  it('renders the empty-state message when nothing is registered', () => {
    const out = renderCircuitBreakerStatus([]);
    expect(out).toContain('No active circuit breakers');
  });

  it('renders open breaker with reopens-in countdown', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 5_000 });
    breaker.recordFailure(1_000);
    breaker.recordFailure(1_001);
    const registry = new CircuitBreakerRegistry();
    registry.register('batch:profile-1:Layout', breaker, 1_000);
    // Manually push a transition (the registry would have via onTransition callback in real wiring)
    registry.recordTransition('batch:profile-1:Layout', {
      from: 'closed',
      to: 'open',
      at: 1_001,
      reason: 'failure-threshold'
    });
    const out = renderCircuitBreakerStatus(registry.list(2_000), 2_000);
    expect(out).toContain('## batch:profile-1:Layout');
    expect(out).toContain('**State:** OPEN');
    expect(out).toContain('Reopens to half-open in:');
    expect(out).toContain('| 999ms ago | `closed` → `open` | failure-threshold |');
  });

  it('renders half-open breaker with progress', () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      halfOpenSuccessThreshold: 3,
      openMs: 100
    });
    breaker.recordFailure(0);
    // Trigger half-open evaluation
    breaker.getState(200);
    const registry = new CircuitBreakerRegistry();
    registry.register('flap', breaker, 0);
    const out = renderCircuitBreakerStatus(registry.list(300), 300);
    expect(out).toContain('**Half-open successes needed:** 0 / 3');
  });
});
