import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfileStore } from '../../src/services/profileStore';
import { InMemoryMemento } from './mocks';

const profile = { id: 'p1', name: 'Dev', authMode: 'direct' as const, serverUrl: 'https://fm.example.com', database: 'Sales', username: 'u' };

describe('ProfileStore change events (they keep the Command Palette context keys current)', () => {
  const make = () => new ProfileStore(new InMemoryMemento() as never, new InMemoryMemento() as never);

  it('fires after a save, a removal and a change of the active profile, once each', async () => {
    const store = make();
    const listener = vi.fn();
    store.onDidChange(listener);

    await store.upsertProfile(profile);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((await store.listProfiles()).length).toBe(1); // the state is already written when the event fires

    await store.setActiveProfileId('p1');
    expect(listener).toHaveBeenCalledTimes(2);

    await store.upsertProfile({ ...profile, name: 'Renamed' });
    expect(listener).toHaveBeenCalledTimes(3);

    await store.removeProfile('p1'); // also clears the active profile, which is a change too
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(await store.listProfiles()).toEqual([]);
  });

  it('fires exactly once for the removal of a profile that is not the active one', async () => {
    const store = make();
    await store.upsertProfile(profile);
    await store.upsertProfile({ ...profile, id: 'p2', name: 'Other' });
    await store.setActiveProfileId('p2');
    const listener = vi.fn();
    store.onDidChange(listener);

    await store.removeProfile('p1');

    expect(listener).toHaveBeenCalledTimes(1);
    expect((await store.listProfiles()).map((item) => item.id)).toEqual(['p2']);
  });

  it('does not fire for a profile that fails validation, stops after dispose, and survives a throwing listener', async () => {
    const store = make();
    const listener = vi.fn();
    const subscription = store.onDidChange(listener);
    store.onDidChange(() => {
      throw new Error('listener bug');
    });

    await expect(store.upsertProfile({ ...profile, serverUrl: 'not a url' })).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();

    await expect(store.upsertProfile(profile)).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);

    subscription.dispose();
    await store.upsertProfile({ ...profile, name: 'Again' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('profiles changed by another window', () => {
  afterEach(() => vi.useRealTimers());
  it('observes shared Memento changes without a local save, once each, and stops when disposed', async () => {
    vi.useFakeTimers();
    const shared = new InMemoryMemento();
    await shared.update('filemakerDataApiTools.profiles', [profile]);
    const local = new ProfileStore(shared as never, new InMemoryMemento() as never);
    const remote = new ProfileStore(shared as never, new InMemoryMemento() as never);
    const listener = vi.fn();
    local.onDidChange(listener);
    // The optional call lets the regression prove that the previous implementation never observes the change.
    const watching = (local as ProfileStore & { watchExternalChanges?: () => { dispose(): void } }).watchExternalChanges?.();
    await remote.upsertProfile({ ...profile, name: 'Renamed elsewhere', aiAccess: 'read' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await local.getProfile('p1')).toMatchObject({ name: 'Renamed elsewhere', aiAccess: 'read' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(listener).toHaveBeenCalledTimes(1);
    await remote.setActiveProfileId('p1');
    await vi.advanceTimersByTimeAsync(2100);
    expect(listener).toHaveBeenCalledTimes(2);
    watching?.dispose();
    await remote.removeProfile('p1');
    await vi.advanceTimersByTimeAsync(2100);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
