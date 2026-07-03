import { describe, expect, it } from 'vitest';

import { ProfileStore } from '../../src/services/profileStore';
import type { ConnectionProfile, SavedQuery } from '../../src/types/fm';
import { InMemoryMemento } from './mocks';

function createProfile(id: string): ConnectionProfile {
  return {
    id,
    name: `Profile ${id}`,
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

describe('ProfileStore', () => {
  it('performs CRUD for profiles and active profile', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);

    const profileA = createProfile('a');
    const profileB = createProfile('b');

    await store.upsertProfile(profileA);
    await store.upsertProfile(profileB);

    const profiles = await store.listProfiles();
    expect(profiles).toHaveLength(2);

    await store.setActiveProfileId('a');
    expect(store.getActiveProfileId()).toBe('a');

    await store.removeProfile('a');

    const remaining = await store.listProfiles();
    expect(remaining.map((item) => item.id)).toEqual(['b']);
    expect(store.getActiveProfileId()).toBeUndefined();
  });

  it('stores saved queries and removes those linked to deleted profile', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);

    await store.upsertProfile(createProfile('a'));
    await store.upsertProfile(createProfile('b'));

    const queryA: SavedQuery = {
      id: 'q-a',
      name: 'Query A',
      profileId: 'a',
      layout: 'Contacts',
      findJson: [{}],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const queryB: SavedQuery = {
      id: 'q-b',
      name: 'Query B',
      profileId: 'b',
      layout: 'Invoices',
      findJson: [{}],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await store.saveQuery(queryA);
    await store.saveQuery(queryB);

    expect(store.listSavedQueries()).toHaveLength(2);

    await store.removeProfile('a');

    const savedQueries = store.listSavedQueries();
    expect(savedQueries).toHaveLength(1);
    expect(savedQueries[0].id).toBe('q-b');
  });

  it('ignores invalid stored profiles during hydration', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);

    await globalState.update('filemakerDataApiTools.profiles', [
      createProfile('valid-profile'),
      {
        id: 'bad',
        name: 'Bad',
        authMode: 'direct',
        serverUrl: 'not-a-url',
        database: 'DB'
      }
    ]);

    const profiles = await store.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe('valid-profile');
  });

  it('persists TLS override fields with normalized profile metadata', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);

    await store.upsertProfile({
      ...createProfile('tls'),
      allowSelfSigned: true,
      caBundlePath: '  /workspace/certs/dev-ca.pem  '
    });

    const profile = await store.getProfile('tls');
    expect(profile?.allowSelfSigned).toBe(true);
    expect(profile?.caBundlePath).toBe('/workspace/certs/dev-ca.pem');
  });
});
