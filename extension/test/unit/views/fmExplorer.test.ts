import { describe, it, expect, vi } from 'vitest';

import { FMExplorerProvider, FMExplorerItem } from '../../../src/views/fmExplorer';

function createMockDeps() {
  return {
    profileStore: {
      listProfiles: vi.fn().mockResolvedValue([]),
      getActiveProfileId: vi.fn().mockReturnValue(undefined),
      getProfile: vi.fn().mockResolvedValue(undefined)
    },
    savedQueriesStore: {
      listQueries: vi.fn().mockResolvedValue([])
    },
    fmClient: {
      listLayouts: vi.fn().mockResolvedValue([]),
      hasSession: vi.fn().mockReturnValue(false)
    },
    schemaService: {
      getLayoutMetadata: vi.fn().mockResolvedValue({ supported: false, fromCache: false, fields: [] })
    },
    snapshotStore: {
      listSummaries: vi.fn().mockResolvedValue([])
    },
    jobRunner: {
      listJobs: vi.fn().mockReturnValue([]),
      getJobSummaries: vi.fn().mockReturnValue([])
    },
    environmentSetStore: {
      listEnvironmentSets: vi.fn().mockResolvedValue([])
    },
    offlineModeService: {
      isOfflineModeEnabled: vi.fn().mockReturnValue(false)
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  };
}

function createProvider(deps = createMockDeps()) {
  return new FMExplorerProvider(
    deps.profileStore as never,
    deps.savedQueriesStore as never,
    deps.fmClient as never,
    deps.schemaService as never,
    deps.snapshotStore as never,
    deps.jobRunner as never,
    deps.environmentSetStore as never,
    deps.offlineModeService as never,
    deps.logger as never
  );
}

describe('FMExplorerProvider', () => {
  describe('getChildren (root)', () => {
    it('returns an empty array when nothing exists (lets viewsWelcome render)', async () => {
      const provider = createProvider();
      const children = await provider.getChildren();

      // Critical: an empty tree triggers contributes.viewsWelcome, which is
      // where the primary "Add Connection Profile" / "Open Walkthrough" CTAs
      // live. Any root node here suppresses that welcome view.
      expect(children).toEqual([]);
    });

    it('returns profile nodes when profiles exist', async () => {
      const deps = createMockDeps();
      deps.profileStore.listProfiles.mockResolvedValue([
        { id: 'p1', name: 'Dev Server', serverUrl: 'https://dev.fm', database: 'DevDB', authMode: 'direct' }
      ]);
      const provider = createProvider(deps);
      const children = await provider.getChildren();

      const profileNodes = children.filter((c) => c.kind === 'profile');
      expect(profileNodes).toHaveLength(1);
      expect(profileNodes[0].label).toBe('Dev Server');
    });

    it('omits Environment Sets root when zero env sets exist', async () => {
      const deps = createMockDeps();
      deps.profileStore.listProfiles.mockResolvedValue([
        { id: 'p1', name: 'Dev', serverUrl: 'https://x', database: 'D', authMode: 'direct' }
      ]);
      const provider = createProvider(deps);
      const children = await provider.getChildren();

      const kinds = children.map((c) => c.kind);
      expect(kinds).not.toContain('environmentSetsRoot');
    });

    it('shows Environment Sets root when at least one env set exists', async () => {
      const deps = createMockDeps();
      deps.environmentSetStore.listEnvironmentSets.mockResolvedValue([
        { id: 'e1', name: 'Prod vs Dev', profiles: ['p1', 'p2'], createdAt: '2026-01-01' }
      ]);
      deps.profileStore.listProfiles.mockResolvedValue([
        { id: 'p1', name: 'Dev', serverUrl: 'https://x', database: 'D', authMode: 'direct' }
      ]);
      const provider = createProvider(deps);
      const children = await provider.getChildren();

      const kinds = children.map((c) => c.kind);
      expect(kinds).toContain('environmentSetsRoot');
    });

    it('omits Jobs root when no jobs are tracked', async () => {
      const deps = createMockDeps();
      deps.profileStore.listProfiles.mockResolvedValue([
        { id: 'p1', name: 'Dev', serverUrl: 'https://x', database: 'D', authMode: 'direct' }
      ]);
      const provider = createProvider(deps);
      const children = await provider.getChildren();

      const kinds = children.map((c) => c.kind);
      expect(kinds).not.toContain('jobsRoot');
    });

    it('shows Jobs root when jobs exist', async () => {
      const deps = createMockDeps();
      deps.jobRunner.listJobs = vi.fn().mockReturnValue([
        { id: 'j1', name: 'Export', status: 'running', progress: 50, startedAt: '2026-01-01' }
      ]);
      deps.profileStore.listProfiles.mockResolvedValue([
        { id: 'p1', name: 'Dev', serverUrl: 'https://x', database: 'D', authMode: 'direct' }
      ]);
      const provider = createProvider(deps);
      const children = await provider.getChildren();

      const kinds = children.map((c) => c.kind);
      expect(kinds).toContain('jobsRoot');
    });

    it('includes offline badge when offline mode is enabled', async () => {
      const deps = createMockDeps();
      deps.offlineModeService.isOfflineModeEnabled.mockReturnValue(true);
      const provider = createProvider(deps);
      const children = await provider.getChildren();

      const badges = children.filter((c) => c.kind === 'offlineBadge');
      expect(badges).toHaveLength(1);
      expect(badges[0].label).toBe('OFFLINE MODE');
    });
  });

  describe('getChildren (profile)', () => {
    it('returns layout and grouping nodes for a profile', async () => {
      const deps = createMockDeps();
      deps.fmClient.hasSession.mockReturnValue(true);
      deps.fmClient.listLayouts.mockResolvedValue(['Contacts', 'Invoices']);
      deps.savedQueriesStore.listQueries.mockResolvedValue([]);

      const provider = createProvider(deps);

      const profileItem = new FMExplorerItem({
        kind: 'profile',
        label: 'Test',
        profileId: 'p1',
        collapsibleState: 1
      });

      const children = await provider.getChildren(profileItem);
      expect(children.length).toBeGreaterThan(0);
    });
  });

  describe('getTreeItem', () => {
    it('returns the item unchanged', async () => {
      const provider = createProvider();
      const item = new FMExplorerItem({
        kind: 'profile',
        label: 'Test Profile',
        contextValue: 'fmProfile'
      });

      const result = await provider.getTreeItem(item);
      expect(result).toBe(item);
    });
  });

  describe('refresh', () => {
    it('fires the onDidChangeTreeData event', () => {
      const provider = createProvider();
      let fired = false;

      provider.onDidChangeTreeData(() => {
        fired = true;
      });

      provider.refresh();
      expect(fired).toBe(true);
    });
  });
});

describe('FMExplorerItem', () => {
  it('stores kind and contextValue', () => {
    const item = new FMExplorerItem({
      kind: 'layout',
      label: 'Contacts',
      contextValue: 'fmLayout',
      profileId: 'p1',
      layoutName: 'Contacts'
    });

    expect(item.kind).toBe('layout');
    expect(item.contextValue).toBe('fmLayout');
    expect(item.profileId).toBe('p1');
    expect(item.layoutName).toBe('Contacts');
  });

  it('defaults collapsible state to None', () => {
    const item = new FMExplorerItem({ kind: 'field', label: 'Name' });
    expect(item.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
  });
});
