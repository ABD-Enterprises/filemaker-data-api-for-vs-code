import { describe, expect, it } from 'vitest';

import { EnvironmentSetStore } from '../../src/enterprise/environmentSetStore';
import { InMemoryMemento } from './mocks';

describe('EnvironmentSetStore', () => {
  it('creates and retrieves environment sets', async () => {
    const store = new EnvironmentSetStore(new InMemoryMemento() as never);

    const created = await store.upsertEnvironmentSet({
      name: 'Core',
      profiles: ['dev', 'test', 'prod']
    });

    expect(created.id).toBeTruthy();

    const list = await store.listEnvironmentSets();
    expect(list).toHaveLength(1);
    expect(list[0]?.profiles).toEqual(['dev', 'test', 'prod']);

    const fetched = await store.getEnvironmentSet(created.id);
    expect(fetched?.name).toBe('Core');
  });

  it('seeds default sets once by name', async () => {
    const store = new EnvironmentSetStore(new InMemoryMemento() as never);

    await store.ensureSeeded([
      {
        name: 'CMS',
        profiles: ['dev', 'prod']
      }
    ]);
    await store.ensureSeeded([
      {
        name: 'CMS',
        profiles: ['dev', 'prod']
      }
    ]);

    const list = await store.listEnvironmentSets();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('CMS');
  });
});
