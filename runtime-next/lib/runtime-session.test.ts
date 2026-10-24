import { describe, expect, it } from 'vitest';

import type { LayoutDefinition } from '@fmweb/shared';

import {
  consumeNavigationIntent,
  loadLayoutSnapshot,
  saveLayoutSnapshot,
  saveNavigationIntent
} from './runtime-session';

const layoutA: Pick<LayoutDefinition, 'id' | 'name' | 'fmLayoutName'> = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Contacts',
  fmLayoutName: 'FM_Contacts'
};

const layoutB: Pick<LayoutDefinition, 'id' | 'name' | 'fmLayoutName'> = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Contact Detail',
  fmLayoutName: 'FM_Contacts'
};

describe('runtime session state', () => {
  it('persists and restores found-set snapshots', () => {
    const storage = createStorage();

    saveLayoutSnapshot(
      layoutA,
      [
        {
          recordId: '10',
          fieldData: {
            Name: 'Alice'
          }
        },
        {
          recordId: '11',
          fieldData: {
            Name: 'Bob'
          }
        }
      ],
      1,
      storage
    );

    const exactSnapshot = loadLayoutSnapshot(layoutA, storage);
    expect(exactSnapshot?.foundSet.length).toBe(2);
    expect(exactSnapshot?.currentIndex).toBe(1);

    const sharedContextSnapshot = loadLayoutSnapshot(layoutB, storage);
    expect(sharedContextSnapshot?.foundSet[0]?.recordId).toBe('10');
  });

  it('stores and consumes navigation intent once for the target layout', () => {
    const storage = createStorage();

    saveNavigationIntent(
      {
        targetLayoutId: 'invoices',
        sourceLayoutId: layoutA.id,
        sourceLayoutName: layoutA.name,
        sourceFmLayoutName: layoutA.fmLayoutName,
        recordId: '42',
        currentRecordIndex: 3,
        foundSetRecordIds: ['40', '41', '42']
      },
      storage
    );

    expect(consumeNavigationIntent('contacts', storage)).toBeUndefined();

    const consumed = consumeNavigationIntent('invoices', storage);
    expect(consumed?.recordId).toBe('42');
    expect(consumed?.sourceLayoutId).toBe(layoutA.id);
    expect(consumed?.currentRecordIndex).toBe(3);

    expect(consumeNavigationIntent('invoices', storage)).toBeUndefined();
  });
});

function createStorage(): Storage {
  const map = new Map<string, string>();

  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.has(key) ? map.get(key) ?? null : null;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    }
  };
}
