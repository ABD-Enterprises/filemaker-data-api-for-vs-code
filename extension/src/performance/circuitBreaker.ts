export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerTransition {
  from: CircuitBreakerState;
  to: CircuitBreakerState;
  at: number;
  reason: 'failure-threshold' | 'half-open-success' | 'half-open-failure' | 'auto-half-open' | 'reset';
}

export interface CircuitBreakerDiagnostics {
  state: CircuitBreakerState;
  failureCount: number;
  failureThreshold: number;
  halfOpenSuccessCount: number;
  halfOpenSuccessThreshold: number;
  openMs: number;
  openUntilMs: number;
  msUntilHalfOpen: number;
}

interface CircuitBreakerOptions {
  failureThreshold?: number;
  openMs?: number;
  halfOpenSuccessThreshold?: number;
  onTransition?: (transition: CircuitBreakerTransition) => void;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly onTransition?: (transition: CircuitBreakerTransition) => void;

  private state: CircuitBreakerState = 'closed';
  private failureCount = 0;
  private openUntil = 0;
  private halfOpenSuccessCount = 0;

  public constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = normalize(options?.failureThreshold, 5, 1, 50);
    this.openMs = normalize(options?.openMs, 5_000, 100, 60_000);
    this.halfOpenSuccessThreshold = normalize(options?.halfOpenSuccessThreshold, 2, 1, 10);
    this.onTransition = options?.onTransition;
  }

  public getState(now = Date.now()): CircuitBreakerState {
    return this.evaluateState(now);
  }

  public getDiagnostics(now = Date.now()): CircuitBreakerDiagnostics {
    const state = this.evaluateState(now);
    return {
      state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      halfOpenSuccessCount: this.halfOpenSuccessCount,
      halfOpenSuccessThreshold: this.halfOpenSuccessThreshold,
      openMs: this.openMs,
      openUntilMs: this.openUntil,
      msUntilHalfOpen: this.state === 'open' ? Math.max(0, this.openUntil - now) : 0
    };
  }

  public canRequest(now = Date.now()): boolean {
    const state = this.evaluateState(now);
    return state !== 'open';
  }

  public recordSuccess(now = Date.now()): void {
    const state = this.evaluateState(now);

    if (state === 'half-open') {
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.halfOpenSuccessThreshold) {
        this.reset(now);
      }
      return;
    }

    this.failureCount = 0;
    this.halfOpenSuccessCount = 0;
  }

  public recordFailure(now = Date.now()): void {
    const state = this.evaluateState(now);

    if (state === 'half-open') {
      this.trip(now, 'half-open-failure');
      return;
    }

    this.failureCount += 1;

    if (this.failureCount >= this.failureThreshold) {
      this.trip(now, 'failure-threshold');
    }
  }

  public reset(now = Date.now()): void {
    const prev = this.state;
    this.state = 'closed';
    this.failureCount = 0;
    this.halfOpenSuccessCount = 0;
    this.openUntil = 0;
    if (prev !== 'closed') {
      this.emit({ from: prev, to: 'closed', at: now, reason: this.transitionReason(prev, 'closed') });
    }
  }

  private trip(now: number, reason: CircuitBreakerTransition['reason']): void {
    const prev = this.state;
    this.state = 'open';
    this.openUntil = now + this.openMs;
    this.failureCount = this.failureThreshold;
    this.halfOpenSuccessCount = 0;
    if (prev !== 'open') {
      this.emit({ from: prev, to: 'open', at: now, reason });
    }
  }

  private evaluateState(now = Date.now()): CircuitBreakerState {
    if (this.state !== 'open') {
      return this.state;
    }

    if (now < this.openUntil) {
      return 'open';
    }

    const prev = this.state;
    this.state = 'half-open';
    this.halfOpenSuccessCount = 0;
    this.emit({ from: prev, to: 'half-open', at: now, reason: 'auto-half-open' });
    return 'half-open';
  }

  private emit(transition: CircuitBreakerTransition): void {
    try {
      this.onTransition?.(transition);
    } catch {
      // Listener errors must never break the breaker; swallow.
    }
  }

  private transitionReason(
    from: CircuitBreakerState,
    to: CircuitBreakerState
  ): CircuitBreakerTransition['reason'] {
    if (to === 'closed' && from === 'half-open') return 'half-open-success';
    return 'reset';
  }
}

function normalize(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}
