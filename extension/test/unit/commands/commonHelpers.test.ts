import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionProfile } from '../../../src/types/fm';
import {
  parseSavedQueryArg,
  resolveProfileFromArg,
  resolveLayoutContext,
  promptForLayout
} from '../../../src/commands/common';

vi.mock('vscode', () => {
  const showErrorMessage = vi.fn();
  const showWarningMessage = vi.fn();
  const showQuickPick = vi.fn();
  return {
    window: {
      showErrorMessage,
      showWarningMessage,
      showQuickPick,
      withProgress: vi.fn((_options, task) => task())
    },
    commands: { executeCommand: vi.fn() },
    ProgressLocation: { Window: 10 }
  };
});

import * as vscode from 'vscode';

interface MockProfileStore {
  profiles: ConnectionProfile[];
  activeProfileId?: string;
  getProfile: (id: string) => Promise<ConnectionProfile | undefined>;
  listProfiles: () => Promise<ConnectionProfile[]>;
  getActiveProfileId: () => string | undefined;
}

function createProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: 'Profile 1',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest',
    username: 'user',
    ...overrides
  };
}

function createStore(profiles: ConnectionProfile[], activeProfileId?: string): MockProfileStore {
  return {
    profiles,
    activeProfileId,
    async getProfile(id: string) {
      return profiles.find((p) => p.id === id);
    },
    async listProfiles() {
      return [...profiles];
    },
    getActiveProfileId() {
      return activeProfileId;
    }
  };
}

describe('resolveProfileFromArg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the profile by id when arg specifies an existing profileId', async () => {
    const store = createStore([
      createProfile({ id: 'p1' }),
      createProfile({ id: 'p2', name: 'P2' })
    ]);
    const result = await resolveProfileFromArg({ profileId: 'p1' }, store as never);
    expect(result?.id).toBe('p1');
    expect(vscode.window.showErrorMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('shows error when profileId is provided but missing', async () => {
    const store = createStore([createProfile({ id: 'p1' })]);
    const result = await resolveProfileFromArg({ profileId: 'missing' }, store as never);
    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.stringContaining('missing')
    );
  });

  it('shows quick pick when arg has no profileId and falls through to picker selection', async () => {
    const store = createStore([
      createProfile({ id: 'p1', name: 'A' }),
      createProfile({ id: 'p2', name: 'B' })
    ]);
    (vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      label: 'B',
      profile: store.profiles[1]
    });
    const result = await resolveProfileFromArg(undefined, store as never);
    expect(result?.id).toBe('p2');
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it('warns when no profiles are configured', async () => {
    const store = createStore([]);
    const result = await resolveProfileFromArg(undefined, store as never);
    expect(result).toBeUndefined();
    expect(vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('preferActive returns the active profile without prompting', async () => {
    const store = createStore(
      [createProfile({ id: 'p1' }), createProfile({ id: 'p2', name: 'P2' })],
      'p2'
    );
    const result = await resolveProfileFromArg(undefined, store as never, true);
    expect(result?.id).toBe('p2');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('preferActive falls through to picker when activeProfileId is stale', async () => {
    const store = createStore(
      [createProfile({ id: 'p1' }), createProfile({ id: 'p2' })],
      'p-deleted'
    );
    (vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      label: 'P1',
      profile: store.profiles[0]
    });
    const result = await resolveProfileFromArg(undefined, store as never, true);
    expect(result?.id).toBe('p1');
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when user cancels the quick pick', async () => {
    const store = createStore([createProfile({ id: 'p1' })]);
    (vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const result = await resolveProfileFromArg(undefined, store as never);
    expect(result).toBeUndefined();
  });

  it('uses the only profile for data commands without an extra prompt', async () => {
    const profile = createProfile();
    const result = await resolveProfileFromArg(undefined, createStore([profile]) as never, true);
    expect(result).toEqual(profile);
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('opens connection setup only when the empty-state action is selected', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      'Add Connection Profile' as never
    );
    await resolveProfileFromArg(undefined, createStore([]) as never);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'filemakerDataApiTools.addConnectionProfile'
    );
  });

  it('does not open connection setup when the warning is dismissed', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);
    await resolveProfileFromArg(undefined, createStore([]) as never);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('lets users distinguish and search profiles by server and database', async () => {
    const profiles = [
      createProfile(),
      createProfile({ id: 'p2', serverUrl: 'https://other.example.com' })
    ];
    await resolveProfileFromArg(undefined, createStore(profiles, 'p2') as never);
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profile: profiles[1],
          description: 'Active',
          detail: expect.stringContaining('https://other.example.com')
        })
      ]),
      expect.objectContaining({ matchOnDetail: true, ignoreFocusOut: true })
    );
  });

  it('does not display credentials embedded in a server URL', async () => {
    await resolveProfileFromArg(
      undefined,
      createStore([
        createProfile({ serverUrl: 'https://user:password@fm.example.com/private?key=secret' })
      ]) as never
    );
    const picks = vi.mocked(vscode.window.showQuickPick).mock
      .calls[0]?.[0] as vscode.QuickPickItem[];
    expect(picks[0]?.detail).toBe('TestDB • https://fm.example.com • direct');
  });
});

describe('layout selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses explicit layout context without fetching layouts or prompting', async () => {
    const profile = createProfile();
    const client = { listLayouts: vi.fn() };
    const result = await resolveLayoutContext(
      { profileId: profile.id, layoutName: 'Contacts' },
      createStore([profile]) as never,
      client as never
    );
    expect(result).toEqual({ profile, layout: 'Contacts' });
    expect(client.listLayouts).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('validates explicit profiles even when a layout is supplied', async () => {
    const client = { listLayouts: vi.fn() };
    const result = await resolveLayoutContext(
      { profileId: 'missing', layout: 'Contacts' },
      createStore([createProfile()]) as never,
      client as never
    );
    expect(result).toBeUndefined();
    expect(client.listLayouts).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });

  it('shows progress and identifies the profile and database in the layout picker', async () => {
    const profile = createProfile();
    const client = { listLayouts: vi.fn().mockResolvedValue(['Contacts']) };
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce('Contacts' as never);
    expect(
      await resolveLayoutContext(undefined, createStore([profile]) as never, client as never)
    ).toEqual({ profile, layout: 'Contacts' });
    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining(profile.name) }),
      expect.any(Function)
    );
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      ['Contacts'],
      expect.objectContaining({
        title: expect.stringContaining(profile.name),
        placeHolder: expect.stringContaining(profile.database)
      })
    );
  });

  it('stops when the layout picker is cancelled', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    const result = await resolveLayoutContext(
      undefined,
      createStore([createProfile()]) as never,
      { listLayouts: vi.fn().mockResolvedValue(['Contacts']) } as never
    );
    expect(result).toBeUndefined();
  });

  it('reports layout loading failures without rejecting or opening a picker', async () => {
    const result = await promptForLayout(createProfile(), {
      listLayouts: vi.fn().mockRejectedValue(new Error('Network unavailable'))
    } as never);
    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Network unavailable'),
      'Details…',
      'Copy as Bug Report'
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('identifies the connection when no layouts are available', async () => {
    const result = await promptForLayout(createProfile(), {
      listLayouts: vi.fn().mockResolvedValue([])
    } as never);
    expect(result).toBeUndefined();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('TestDB')
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });
});

describe('parseSavedQueryArg', () => {
  it('returns empty result for non-objects', () => {
    expect(parseSavedQueryArg(null)).toEqual({});
    expect(parseSavedQueryArg(undefined)).toEqual({});
    expect(parseSavedQueryArg(42)).toEqual({});
    expect(parseSavedQueryArg('x')).toEqual({});
  });

  it('reads profileId and queryId', () => {
    expect(parseSavedQueryArg({ profileId: 'p1', queryId: 'q1' })).toEqual({
      profileId: 'p1',
      queryId: 'q1'
    });
  });

  it('falls back to savedQueryId when queryId is missing', () => {
    expect(parseSavedQueryArg({ savedQueryId: 'sq1' })).toEqual({
      profileId: undefined,
      queryId: 'sq1'
    });
  });

  it('prefers queryId over savedQueryId when both are present', () => {
    expect(parseSavedQueryArg({ queryId: 'q1', savedQueryId: 'sq1' })).toEqual({
      profileId: undefined,
      queryId: 'q1'
    });
  });

  it('ignores non-string ids', () => {
    expect(parseSavedQueryArg({ profileId: 42, queryId: { foo: 'bar' } })).toEqual({});
  });
});
