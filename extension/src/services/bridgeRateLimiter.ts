/**
 * Token-bucket rate limiter + hard request-budget cap for the FM bridge server.
 *
 * The bridge listens on 127.0.0.1 + a random per-session token. The token check
 * is the trust boundary, but a misbehaving local process holding the token can
 * still hammer FileMaker indefinitely. This limiter caps both throughput
 * (per-second burst) and total volume (per-token-lifetime budget) so a runaway
 * client gets backpressure and eventually 429s.
 */

export interface BridgeRateLimitConfig {
  /** Sustained allowed requests per second. */
  perSecond: number;
  /** Burst capacity — max requests permitted in a single instant when refilled. */
  burst: number;
  /** Hard cap on total requests over the lifetime of one session token. */
  budget: number;
}

export const DEFAULT_BRIDGE_RATE_LIMIT: BridgeRateLimitConfig = {
  perSecond: 20,
  burst: 60,
  budget: 10_000
};

export interface RateLimitDecision {
  ok: boolean;
  /** When non-ok, ms the client should wait before retrying. 0 for budget-exhausted (no retry). */
  retryAfterMs: number;
  /** Why the request was denied (when !ok). */
  reason?: 'rate' | 'budget';
  /** Snapshot of remaining counters — useful for logging. */
  remaining: {
    tokens: number;
    budget: number;
  };
}

const SECOND_MS = 1000;

export class BridgeRateLimiter {
  private tokens: number;
  private consumed = 0;
  private lastRefillMs: number;

  public constructor(
    private readonly config: BridgeRateLimitConfig = DEFAULT_BRIDGE_RATE_LIMIT,
    private readonly now: () => number = Date.now
  ) {
    if (config.perSecond <= 0) {
      throw new Error('BridgeRateLimiter: perSecond must be > 0');
    }
    if (config.burst <= 0) {
      throw new Error('BridgeRateLimiter: burst must be > 0');
    }
    if (config.budget <= 0) {
      throw new Error('BridgeRateLimiter: budget must be > 0');
    }
    this.tokens = config.burst;
    this.lastRefillMs = this.now();
  }

  /**
   * Try to consume one token. Returns a decision: ok=true and the request
   * proceeds, ok=false with a retryAfterMs hint for 429 responses.
   */
  public tryConsume(): RateLimitDecision {
    if (this.consumed >= this.config.budget) {
      return {
        ok: false,
        retryAfterMs: 0,
        reason: 'budget',
        remaining: { tokens: this.tokens, budget: 0 }
      };
    }

    this.refill();

    if (this.tokens < 1) {
      // Compute ms until the next whole token is refilled.
      const msPerToken = SECOND_MS / this.config.perSecond;
      const deficit = 1 - this.tokens;
      const retryAfterMs = Math.max(1, Math.ceil(deficit * msPerToken));
      return {
        ok: false,
        retryAfterMs,
        reason: 'rate',
        remaining: {
          tokens: this.tokens,
          budget: this.config.budget - this.consumed
        }
      };
    }

    this.tokens -= 1;
    this.consumed += 1;
    return {
      ok: true,
      retryAfterMs: 0,
      remaining: {
        tokens: this.tokens,
        budget: this.config.budget - this.consumed
      }
    };
  }

  /** Reset state. Called when the bridge issues a new session token. */
  public reset(): void {
    this.tokens = this.config.burst;
    this.consumed = 0;
    this.lastRefillMs = this.now();
  }

  /** For diagnostics. */
  public snapshot(): { tokens: number; consumed: number; budgetRemaining: number } {
    return {
      tokens: this.tokens,
      consumed: this.consumed,
      budgetRemaining: this.config.budget - this.consumed
    };
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    if (elapsedMs === 0) return;
    const addedTokens = (elapsedMs / SECOND_MS) * this.config.perSecond;
    this.tokens = Math.min(this.config.burst, this.tokens + addedTokens);
    this.lastRefillMs = now;
  }
}

export function normalizeBridgeRateLimitConfig(
  raw: Partial<BridgeRateLimitConfig> | undefined
): BridgeRateLimitConfig {
  const cfg = raw ?? {};
  const perSecond = Number.isFinite(cfg.perSecond) && (cfg.perSecond ?? 0) > 0
    ? Math.floor(cfg.perSecond as number)
    : DEFAULT_BRIDGE_RATE_LIMIT.perSecond;
  const burst = Number.isFinite(cfg.burst) && (cfg.burst ?? 0) > 0
    ? Math.floor(cfg.burst as number)
    : DEFAULT_BRIDGE_RATE_LIMIT.burst;
  const budget = Number.isFinite(cfg.budget) && (cfg.budget ?? 0) > 0
    ? Math.floor(cfg.budget as number)
    : DEFAULT_BRIDGE_RATE_LIMIT.budget;
  return { perSecond, burst, budget };
}
