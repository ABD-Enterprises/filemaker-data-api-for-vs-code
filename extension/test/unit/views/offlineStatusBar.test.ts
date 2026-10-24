import { describe, expect, it } from 'vitest';

import { computeOfflineStatus, formatAge } from '../../../src/views/offlineStatusBar';

describe('formatAge', () => {
  it('renders sub-hour ages in minutes (with floor of 1m)', () => {
    expect(formatAge(0)).toBe('1m');
    expect(formatAge(0.5)).toBe('30m');
    expect(formatAge(0.999)).toBe('60m');
  });

  it('renders 1-23h as hours', () => {
    expect(formatAge(1)).toBe('1h');
    expect(formatAge(23.4)).toBe('23h');
  });

  it('renders 24h+ as days', () => {
    expect(formatAge(24)).toBe('1d');
    expect(formatAge(48)).toBe('2d');
    expect(formatAge(72)).toBe('3d');
  });
});

describe('computeOfflineStatus', () => {
  const now = new Date('2026-05-04T12:00:00Z');

  it('hides when offline=false and cache is fresh', () => {
    const fresh = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
    const status = computeOfflineStatus(
      { offlineMode: false, newestCapturedAt: fresh },
      24,
      now
    );
    expect(status.visible).toBe(false);
    expect(status.stale).toBe(false);
  });

  it('hides when offline=false and no cache exists', () => {
    const status = computeOfflineStatus({ offlineMode: false }, 24, now);
    expect(status.visible).toBe(false);
  });

  it('shows offline label when offline=true regardless of staleness', () => {
    const fresh = new Date(now.getTime() - 60 * 60 * 1000);
    const status = computeOfflineStatus(
      { offlineMode: true, newestCapturedAt: fresh },
      24,
      now
    );
    expect(status.visible).toBe(true);
    expect(status.text).toContain('Offline');
    expect(status.text).toContain('1h');
    expect(status.stale).toBe(false);
  });

  it('marks cache stale and visible when threshold exceeded even when offline=false', () => {
    const old = new Date(now.getTime() - 30 * 60 * 60 * 1000); // 30 hours ago
    const status = computeOfflineStatus(
      { offlineMode: false, newestCapturedAt: old },
      24,
      now
    );
    expect(status.visible).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.text).toContain('Cache stale');
    expect(status.text).toContain('1d');
  });

  it('shows offline label with no-cache when offline=true and no entries cached', () => {
    const status = computeOfflineStatus({ offlineMode: true }, 24, now);
    expect(status.visible).toBe(true);
    expect(status.text).toContain('Offline');
    expect(status.text).toContain('no cache');
    expect(status.stale).toBe(false);
  });

  it('disables stale check when staleHours <= 0', () => {
    const old = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const status = computeOfflineStatus(
      { offlineMode: false, newestCapturedAt: old },
      0,
      now
    );
    expect(status.visible).toBe(false);
    expect(status.stale).toBe(false);
  });

  it('treats threshold edge inclusively (>= staleHours = stale)', () => {
    const exactly24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const status = computeOfflineStatus(
      { offlineMode: false, newestCapturedAt: exactly24h },
      24,
      now
    );
    expect(status.stale).toBe(true);
  });
});
