import { describe, expect, it } from 'vitest';

import { SessionTokenTracker } from '../../../src/services/session/sessionTokenTracker';

describe('SessionTokenTracker', () => {
  it('returns false for an unknown profile (trust persisted token)', () => {
    const tracker = new SessionTokenTracker();
    expect(tracker.shouldRefresh('unknown')).toBe(false);
  });

  it('markIssued + shouldRefresh: fresh token within lifetime returns false', () => {
    const tracker = new SessionTokenTracker({
      defaultMaxAgeMs: 60_000,
      defaultRefreshLeadMs: 5_000
    });
    tracker.markIssued('p1', 1_000_000);
    expect(tracker.shouldRefresh('p1', 1_001_000)).toBe(false); // 1s old, lifetime 55s
  });

  it('shouldRefresh returns true once lifetime elapses (maxAge - refreshLead)', () => {
    const tracker = new SessionTokenTracker({
      defaultMaxAgeMs: 60_000,
      defaultRefreshLeadMs: 5_000
    });
    tracker.markIssued('p1', 1_000_000);
    // lifetime = 60s - 5s = 55s
    expect(tracker.shouldRefresh('p1', 1_055_000)).toBe(true);
    expect(tracker.shouldRefresh('p1', 1_054_000)).toBe(false);
  });

  it('refreshLeadMs <= 0 disables proactive refresh entirely', () => {
    const tracker = new SessionTokenTracker({
      defaultMaxAgeMs: 60_000,
      defaultRefreshLeadMs: 0
    });
    tracker.markIssued('p1', 0);
    expect(tracker.shouldRefresh('p1', 1_000_000)).toBe(false);
  });

  it('clamps negative ageMs (clock-skew) to 0', () => {
    const tracker = new SessionTokenTracker({
      defaultMaxAgeMs: 60_000,
      defaultRefreshLeadMs: 5_000
    });
    tracker.markIssued('p1', 2_000_000);
    // Clock jumped backwards
    expect(tracker.shouldRefresh('p1', 1_000_000)).toBe(false);
  });

  it('clamps lifetime to maxAgeMs when refreshLead >= maxAge (no infinite loop)', () => {
    const tracker = new SessionTokenTracker({
      defaultMaxAgeMs: 10_000,
      defaultRefreshLeadMs: 20_000
    });
    tracker.markIssued('p1', 0);
    expect(tracker.shouldRefresh('p1', 5_000)).toBe(false);
    expect(tracker.shouldRefresh('p1', 10_000)).toBe(true);
  });

  it('clear() forgets issuance and makes shouldRefresh return false again', () => {
    const tracker = new SessionTokenTracker({
      defaultMaxAgeMs: 60_000,
      defaultRefreshLeadMs: 5_000
    });
    tracker.markIssued('p1', 0);
    expect(tracker.shouldRefresh('p1', 1_000_000)).toBe(true); // far past lifetime
    tracker.clear('p1');
    expect(tracker.shouldRefresh('p1', 1_000_000)).toBe(false);
  });

  it('per-call options override defaults', () => {
    const tracker = new SessionTokenTracker({
      defaultMaxAgeMs: 60_000,
      defaultRefreshLeadMs: 5_000
    });
    tracker.markIssued('p1', 0);
    // Default would say refresh (55s lifetime, now=60s); override to large maxAge
    expect(
      tracker.shouldRefresh('p1', { now: 60_000, maxAgeMs: 300_000, refreshLeadMs: 5_000 })
    ).toBe(false);
  });

  it('getIssuedAt exposes the recorded time for diagnostics', () => {
    const tracker = new SessionTokenTracker();
    tracker.markIssued('p1', 42);
    expect(tracker.getIssuedAt('p1')).toBe(42);
    tracker.clear('p1');
    expect(tracker.getIssuedAt('p1')).toBeUndefined();
  });
});
