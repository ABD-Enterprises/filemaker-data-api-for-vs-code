import { assert, describe, expect, it } from 'vitest';

import { SavedQueriesStore } from '../../src/services/savedQueriesStore';
import type { SavedQuery } from '../../src/types/fm';
import { InMemoryMemento } from './mocks';

const DATA_VERSION_KEY = 'filemaker.savedQueries.schemaVersion';
const LEGACY_KEY = 'filemakerDataApiTools.savedQueries';

function createQuery(id: string): SavedQuery {
  const now = new Date().toISOString();

  return {
    id,
    name: `Query ${id}`,
    profileId: 'profile-a',
    database: 'DB',
    layout: 'Contacts',
    findJson: [{ Name: 'Ada' }],
    sortJson: [{ fieldName: 'Name', sortOrder: 'ascend' }],
    limit: 10,
    offset: 0,
    createdAt: now,
    updatedAt: now
  };
}

describe('SavedQueriesStore', () => {
  it('stores and updates queries using workspace scope', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();

    const store = new SavedQueriesStore(globalState as never, workspaceState as never, {
      getScope: () => 'workspace'
    });

    const created = await store.saveSavedQuery(createQuery('q-1'));
    expect(created.id).toBe('q-1');

    const afterCreate = await store.listSavedQueries();
    expect(afterCreate).toHaveLength(1);
    assert.isDefined(afterCreate[0]);

    await store.saveSavedQuery({
      ...afterCreate[0],
      name: 'Renamed Query'
    });

    const afterUpdate = await store.listSavedQueries();
    expect(afterUpdate[0]?.name).toBe('Renamed Query');
  });

  it('migrates legacy saved query payloads and sets schema version', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();

    await workspaceState.update(LEGACY_KEY, [
      {
        id: 'legacy-1',
        name: 'Legacy Query',
        profileId: 'profile-a',
        layout: 'Contacts',
        findJson: '[{"Name":"Ada"}]',
        sortJson: '[{"fieldName":"Name"}]',
        limit: 5,
        offset: 0,
        createdAt: new Date().toISOString()
      }
    ]);

    const store = new SavedQueriesStore(globalState as never, workspaceState as never, {
      getScope: () => 'workspace'
    });

    const queries = await store.listSavedQueries();

    expect(queries).toHaveLength(1);
    expect(queries[0]?.findJson).toEqual([{ Name: 'Ada' }]);
    expect(workspaceState.get(DATA_VERSION_KEY)).toBe(1);
  });

  it('imports and dedupes by id', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();

    const store = new SavedQueriesStore(globalState as never, workspaceState as never, {
      getScope: () => 'workspace'
    });

    await store.saveSavedQuery(createQuery('dup-1'));

    const payload = {
      schemaVersion: 1,
      queries: [
        {
          ...createQuery('dup-1'),
          name: 'Updated Name'
        },
        createQuery('new-1')
      ]
    };

    const result = await store.importSavedQueries(JSON.stringify(payload));

    expect(result.imported).toBe(1);
    expect(result.updated).toBe(1);

    const all = await store.listSavedQueries();
    expect(all.map((item) => item.id).sort()).toEqual(['dup-1', 'new-1']);
  });
});

it.each([
  ['{not json', 'That file is not valid JSON'],
  ['null', 'That JSON file does not contain saved queries'],
  ['{}', 'That JSON file does not contain saved queries'],
  ['{"queries":{}}', 'That JSON file does not contain saved queries'],
  ['[null]', 'That JSON file does not contain saved queries'],
  ['[{}]', 'That JSON file does not contain saved queries'],
  [JSON.stringify([{ ...createQuery('new'), findJson: [null] }]), 'That JSON file does not contain saved queries'],
  [JSON.stringify([{ ...createQuery('new'), sortJson: {} }]), 'That JSON file does not contain saved queries'],
  [JSON.stringify([createQuery('new'), { unrelated: true }]), 'That JSON file does not contain saved queries']
])('rejects invalid import %s without changing saved queries', async (text, message) => {
  const store = new SavedQueriesStore(new InMemoryMemento() as never, new InMemoryMemento() as never);
  await store.saveSavedQuery(createQuery('keep'));
  const before = await store.listSavedQueries();
  await expect(store.importSavedQueries(text)).rejects.toThrow(message);
  expect(await store.listSavedQueries()).toEqual(before);
});
