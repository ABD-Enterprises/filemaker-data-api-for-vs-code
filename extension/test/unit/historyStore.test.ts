import { describe, expect, it } from 'vitest';

import { HistoryStore } from '../../src/services/historyStore';
import { InMemoryMemento } from './mocks';

describe('HistoryStore', () => {
  it('enforces max entries as a ring buffer', async () => {
    const workspaceState = new InMemoryMemento();

    const store = new HistoryStore(workspaceState as never, {
      getMaxEntries: () => 2
    });

    await store.record({
      profileId: 'p1',
      operation: 'listLayouts',
      durationMs: 10,
      success: true
    });

    await store.record({
      profileId: 'p1',
      operation: 'findRecords',
      layout: 'Contacts',
      durationMs: 12,
      success: true
    });

    await store.record({
      profileId: 'p1',
      operation: 'getRecord',
      layout: 'Contacts',
      durationMs: 15,
      success: false,
      httpStatus: 404
    });

    const entries = store.listEntries();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.operation).toBe('getRecord');
    expect(entries[1]?.operation).toBe('findRecords');
  });
});
