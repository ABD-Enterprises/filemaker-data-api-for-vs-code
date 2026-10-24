import { describe, expect, it } from 'vitest';

import { MetricsStore } from '../../src/diagnostics/metricsStore';
import { InMemoryMemento } from './mocks';

describe('MetricsStore', () => {
  it('records metrics and computes summary aggregates', async () => {
    const store = new MetricsStore(new InMemoryMemento() as never, {
      getMaxEntries: () => 200
    });

    await store.record({
      requestId: 'req-1',
      profileId: 'dev',
      operation: 'listLayouts',
      endpoint: 'GET /layouts',
      durationMs: 120,
      success: true,
      reauthCount: 0,
      cacheHit: true
    });

    await store.record({
      requestId: 'req-2',
      profileId: 'dev',
      operation: 'listLayouts',
      endpoint: 'GET /layouts',
      durationMs: 300,
      success: false,
      httpStatus: 500,
      reauthCount: 1,
      cacheHit: false
    });

    const summary = store.getSummary();

    expect(summary.totalRequests).toBe(2);
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.totalReauthCount).toBe(1);
    expect(summary.endpoints).toHaveLength(1);
    expect(summary.endpoints[0]?.cacheHitRatio).toBe(0.5);
  });

  it('enforces rolling max entries', async () => {
    const store = new MetricsStore(new InMemoryMemento() as never, {
      getMaxEntries: () => 3
    });

    for (let index = 0; index < 5; index += 1) {
      await store.record({
        requestId: `req-${index}`,
        profileId: 'dev',
        operation: 'findRecords',
        endpoint: 'POST /layouts/Contacts/_find',
        durationMs: 50 + index,
        success: true
      });
    }

    const entries = store.listEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.requestId).toBe('req-4');
    expect(entries[2]?.requestId).toBe('req-2');
  });
});
