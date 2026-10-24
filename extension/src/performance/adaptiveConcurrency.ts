export interface AdaptiveConcurrencySnapshot {
  current: number;
  min: number;
  max: number;
  avgLatencyMs: number;
  sampleCount: number;
  failureStreak: number;
}

interface AdaptiveConcurrencyOptions {
  initial?: number;
  min?: number;
  max?: number;
  targetLatencyMs?: number;
  growEvery?: number;
}

export class AdaptiveConcurrency {
  private readonly min: number;
  private readonly max: number;
  private readonly targetLatencyMs: number;
  private readonly growEvery: number;

  private current: number;
  private latencySamples: number[] = [];
  private successSinceGrow = 0;
  private failureStreak = 0;

  public constructor(options?: AdaptiveConcurrencyOptions) {
    this.min = clamp(options?.min ?? 1, 1, 16);
    this.max = clamp(options?.max ?? 8, this.min, 32);
    this.current = clamp(options?.initial ?? this.min, this.min, this.max);
    this.targetLatencyMs = clamp(options?.targetLatencyMs ?? 800, 50, 10_000);
    this.growEvery = clamp(options?.growEvery ?? 6, 1, 50);
  }

  public getLimit(): number {
    return this.current;
  }

  public recordSuccess(latencyMs: number): void {
    const normalizedLatency = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : this.targetLatencyMs;
    this.latencySamples.push(normalizedLatency);
    if (this.latencySamples.length > 20) {
      this.latencySamples = this.latencySamples.slice(-20);
    }

    this.successSinceGrow += 1;
    this.failureStreak = 0;

    const avg = this.getAverageLatency();
    if (avg <= this.targetLatencyMs * 0.85 && this.successSinceGrow >= this.growEvery) {
      this.current = clamp(this.current + 1, this.min, this.max);
      this.successSinceGrow = 0;
      return;
    }

    if (avg > this.targetLatencyMs * 1.4 && this.current > this.min) {
      this.current = clamp(this.current - 1, this.min, this.max);
      this.successSinceGrow = 0;
    }
  }

  public recordFailure(status?: number): void {
    this.failureStreak += 1;
    this.successSinceGrow = 0;

    const hardFailure = status === 429 || (typeof status === 'number' && status >= 500);
    if (hardFailure || this.failureStreak >= 2) {
      const dropBy = hardFailure ? 2 : 1;
      this.current = clamp(this.current - dropBy, this.min, this.max);
    }
  }

  public getBackoffDelayMs(attempt: number, status?: number): number {
    const normalizedAttempt = clamp(attempt, 0, 8);
    const base = status === 429 ? 400 : 250;
    const jitter = 25 * Math.floor(Math.random() * 4);

    return base * Math.pow(2, normalizedAttempt) + jitter;
  }

  public snapshot(): AdaptiveConcurrencySnapshot {
    return {
      current: this.current,
      min: this.min,
      max: this.max,
      avgLatencyMs: this.getAverageLatency(),
      sampleCount: this.latencySamples.length,
      failureStreak: this.failureStreak
    };
  }

  private getAverageLatency(): number {
    if (this.latencySamples.length === 0) {
      return this.targetLatencyMs;
    }

    return this.latencySamples.reduce((sum, value) => sum + value, 0) / this.latencySamples.length;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}
