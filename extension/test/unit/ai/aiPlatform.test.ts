import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  commands: { executeCommand: vi.fn(async () => undefined) },
  env: { openExternal: vi.fn(async () => true) },
  window: { showWarningMessage: vi.fn(async () => undefined) },
  Uri: { parse: (value: string) => ({ toString: () => value }) }
}));

import { RoleGuard } from '../../../src/enterprise/roleGuard';
import { ProfileStore } from '../../../src/services/profileStore';
import type { ConnectionProfile } from '../../../src/types/fm';
import { InMemoryMemento } from '../mocks';

function guardWith(config: Record<string, unknown>, offline = false) {
  return new RoleGuard(
    { debug: vi.fn(), warn: vi.fn() },
    {
      getConfiguration: () =>
        ({ get: (key: string, fallback?: unknown) => (key === 'offline.mode' ? offline : fallback) }) as never,
      isWorkspaceTrusted: () => true,
      getWorkspaceRoot: () => '/workspace',
      readConfigFile: async () => JSON.stringify(config)
    }
  );
}

describe('enterprise feature list', () => {
  it('lets disabledFeatures turn AI off, and knows the id', async () => {
    const guard = guardWith({ disabledFeatures: ['ai', 'bogus'] });
    await guard.refresh();
    expect(guard.getFeatureGuard('ai').allowed).toBe(false);
    expect(guard.getFeatureGuard('recordEdit').allowed).toBe(true);
  });

  it('keeps AI on when the file does not disable it', async () => {
    const guard = guardWith({ disabledFeatures: ['recordEdit'] });
    await guard.refresh();
    expect(guard.getFeatureGuard('ai').allowed).toBe(true);
    expect(guard.getFeatureGuard('recordEdit').allowed).toBe(false);
  });

  it('blocks write features in offline mode, which is what keeps AI writes off', async () => {
    const guard = guardWith({}, true);
    await guard.refresh();
    expect(guard.getFeatureGuard('recordEdit').allowed).toBe(false);
    expect(guard.getFeatureGuard('scriptRunner').allowed).toBe(false);
  });
});

describe('profile aiAccess', () => {
  const base: ConnectionProfile = {
    id: 'a',
    name: 'A',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'DB'
  };

  it('defaults to none: no key is stored and an old profile reads as none', async () => {
    const memento = new InMemoryMemento();
    const store = new ProfileStore(memento as never, new InMemoryMemento() as never);
    await store.upsertProfile(base);
    expect((await store.getProfile('a'))?.aiAccess).toBeUndefined();
  });

  it('keeps read and write', async () => {
    const store = new ProfileStore(new InMemoryMemento() as never, new InMemoryMemento() as never);
    await store.upsertProfile({ ...base, aiAccess: 'read' });
    await store.upsertProfile({ ...base, id: 'b', aiAccess: 'write' });
    expect((await store.getProfile('a'))?.aiAccess).toBe('read');
    expect((await store.getProfile('b'))?.aiAccess).toBe('write');
  });

  it('turns anything else, including stored junk, into none on read and on write', async () => {
    const memento = new InMemoryMemento();
    await memento.update('filemakerDataApiTools.profiles', [
      { ...base, aiAccess: 'admin' },
      { ...base, id: 'c', aiAccess: true },
      { ...base, id: 'd', aiAccess: 'none' }
    ]);
    const store = new ProfileStore(memento as never, new InMemoryMemento() as never);
    const profiles = await store.listProfiles();
    expect(profiles.map((profile) => profile.aiAccess)).toEqual([undefined, undefined, undefined]);
    await store.upsertProfile({ ...base, aiAccess: 'root' as never });
    expect((await store.getProfile('a'))?.aiAccess).toBeUndefined();
  });

  it('a profile saved with write keeps it when the lenient hydration re-reads it', async () => {
    const memento = new InMemoryMemento();
    const store = new ProfileStore(memento as never, new InMemoryMemento() as never);
    await store.upsertProfile({ ...base, aiAccess: 'write', serverUrl: 'https://user:pw@fm.example.com' } as never).catch(() => undefined);
    await store.upsertProfile({ ...base, aiAccess: 'write' });
    expect((await store.listProfiles())[0]?.aiAccess).toBe('write');
  });
});
