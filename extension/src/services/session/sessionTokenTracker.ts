/**
 * Per-profile session-token lifecycle state.
 *
 * Extracted from FMClient (issue #75 — split fmClient.ts into focused
 * services). This first slice owns the in-memory issuance-time map and the
 * `shouldRefreshSession` decision logic. The actual createSession / 401-retry
 * HTTP work continues to live in FMClient and calls back into the tracker via
 * markIssued() / clear().
 *
 * Subsequent slices of #75 will extract:
 * - AuthService (createSession + login flow, currently embedded in FMClient)
 * - ApiClient (HTTP transport, headers, abort, timeout)
 * - Endpoint handlers (one file per Data API resource)
 */

export interface SessionTokenTrackerOptions {
  /** Default 14 minutes (FM Data API tokens nominally expire at 15). */
  defaultMaxAgeMs?: number;
  /** Default 30 seconds (refresh proactively this far before nominal expiry). */
  defaultRefreshLeadMs?: number;
}

export const DEFAULT_SESSION_MAX_AGE_MS = 14 * 60 * 1000;
export const DEFAULT_SESSION_REFRESH_LEAD_MS = 30 * 1000;

export class SessionTokenTracker {
  private readonly issuedAt = new Map<string, number>();
  private readonly defaultMaxAgeMs: number;
  private readonly defaultRefreshLeadMs: number;

  public constructor(options?: SessionTokenTrackerOptions) {
    this.defaultMaxAgeMs = options?.defaultMaxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS;
    this.defaultRefreshLeadMs =
      options?.defaultRefreshLeadMs ?? DEFAULT_SESSION_REFRESH_LEAD_MS;
  }

  /** Record that a token was issued at `now` (defaults to Date.now()). */
  public markIssued(profileId: string, now: number = Date.now()): void {
    this.issuedAt.set(profileId, now);
  }

  /** Forget the issuance window — call on deleteSession / 401-driven invalidation. */
  public clear(profileId: string): void {
    this.issuedAt.delete(profileId);
  }

  /** Visible for diagnostics. */
  public getIssuedAt(profileId: string): number | undefined {
    return this.issuedAt.get(profileId);
  }

  /**
   * Decide whether the session for `profileId` should be refreshed before the next
   * authenticated request.
   *
   * Behavior:
   * - `refreshLeadMs <= 0` disables proactive refresh entirely (rely on 401-retry).
   * - Unknown profile (no recorded issuance) returns false — the persisted token
   *   is trusted; 401-retry will catch real expiry. This prevents orphaning
   *   sessions on every extension restart.
   * - Negative ageMs (clock skew) is clamped to 0 so a backwards clock jump
   *   doesn't extend the perceived lifetime.
   * - If `refreshLeadMs >= maxAgeMs`, lifetime is clamped to maxAgeMs to avoid
   *   an infinite refresh loop where every check thinks a refresh is overdue.
   */
  public shouldRefresh(
    profileId: string,
    nowOrOpts: number | { now?: number; maxAgeMs?: number; refreshLeadMs?: number } = Date.now()
  ): boolean {
    const opts =
      typeof nowOrOpts === 'number'
        ? { now: nowOrOpts, maxAgeMs: this.defaultMaxAgeMs, refreshLeadMs: this.defaultRefreshLeadMs }
        : {
            now: nowOrOpts.now ?? Date.now(),
            maxAgeMs: nowOrOpts.maxAgeMs ?? this.defaultMaxAgeMs,
            refreshLeadMs: nowOrOpts.refreshLeadMs ?? this.defaultRefreshLeadMs
          };

    if (opts.refreshLeadMs <= 0) {
      return false;
    }

    const issuedAt = this.issuedAt.get(profileId);
    if (issuedAt === undefined) {
      return false;
    }

    const ageMs = Math.max(0, opts.now - issuedAt);
    const lifetimeMs =
      opts.refreshLeadMs >= opts.maxAgeMs
        ? opts.maxAgeMs
        : opts.maxAgeMs - opts.refreshLeadMs;
    return ageMs >= Math.max(0, lifetimeMs);
  }
}
