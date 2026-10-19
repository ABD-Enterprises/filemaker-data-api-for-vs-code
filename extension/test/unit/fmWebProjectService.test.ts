import { mkdir, readFile, rm, writeFile, symlink } from 'fs/promises';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionProfile } from '../../src/types/fm';
import { FmWebProjectService } from '../../src/services/fmWebProjectService';

const WORKSPACE_ROOT = '/tmp/workspace';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Local Profile',
  serverUrl: 'https://example.com',
  database: 'AppDB',
  authMode: 'direct',
  username: 'dev'
};

describe('FmWebProjectService', () => {
  beforeEach(async () => {
    await mkdir(WORKSPACE_ROOT, { recursive: true });
    await rm(path.join(WORKSPACE_ROOT, '.fmweb'), { recursive: true, force: true });
  });

  it('initializes project folders and config', async () => {
    const service = new FmWebProjectService(
      createProfileStoreStub(),
      createFmClientStub(),
      createSchemaServiceStub(),
      logger
    );

    const project = await service.initializeProject('Demo');

    expect(project.name).toBe('Demo');

    const configRaw = await readFile(path.join(WORKSPACE_ROOT, '.fmweb', 'project.json'), 'utf8');
    const config = JSON.parse(configRaw) as { name: string };
    expect(config.name).toBe('Demo');
  });

  it('tells listeners when the project file has been written, after it exists (the command context key depends on it)', async () => {
    const service = new FmWebProjectService(createProfileStoreStub(), createFmClientStub(), createSchemaServiceStub(), logger);
    const seen: Array<string | undefined> = [];
    const subscription = service.onDidChangeProject(() => {
      seen.push('fired');
    });
    service.onDidChangeProject(() => {
      throw new Error('listener bug');
    });

    await service.initializeProject('Demo');
    expect(seen).toEqual(['fired']);
    expect((await service.readProjectConfig())?.name).toBe('Demo'); // already readable when the event fires

    subscription.dispose();
    await service.initializeProject('Demo');
    expect(seen).toEqual(['fired']);
  });

  it('keeps field names exactly in the synced field list, and skips blank ones', async () => {
    const service = new FmWebProjectService(
      createProfileStoreStub(),
      createFmClientStub({
        listLayouts: vi.fn(async () => ['Contacts']),
        getLayoutMetadata: vi.fn(async () => ({ fieldMetaData: [{ name: ' Photo' }, { name: 'Photo' }, { name: '   ' }] }))
      }),
      createSchemaServiceStub(),
      logger
    );
    await service.initializeProject();
    const summary = await service.syncMetadata(profile);
    expect(summary.fieldCount).toBe(2);
    const cache = JSON.parse(await readFile(path.join(WORKSPACE_ROOT, '.fmweb', 'metadata', 'index.json'), 'utf8')) as { fields?: string[]; allFields?: string[] };
    expect(JSON.stringify(cache)).toContain('" Photo"');
  });

  it('passes stored metadata order, field types, exact names and the first portal to the designer', async () => {
    const service = new FmWebProjectService(createProfileStoreStub(), createFmClientStub({
      listLayouts: vi.fn(async () => [' Contacts ']),
      getLayoutMetadata: vi.fn(async () => ({
        fieldMetaData: [{ name: ' Z', result: 'number' }, { name: 'A', result: 'container' }],
        portalMetaData: { ' Related ': [{ name: ' Related::Value ' }] }
      }))
    }), createSchemaServiceStub(), logger);
    await service.initializeProject();
    await service.syncMetadata(profile);
    expect(await service.getAvailableFields(' Contacts ')).toEqual([' Z', 'A']);
    expect(await service.getDesignerLayouts()).toEqual([{
      layoutName: ' Contacts ', fields: [
        { name: ' Z', type: 'number', multiline: false }, { name: 'A', type: 'container', multiline: false }
      ], portals: [{ name: ' Related ', fields: [' Related::Value '] }]
    }]);
  });

  it('falls back to cached names for old or missing metadata and refuses paths outside the metadata folder', async () => {
    const service = new FmWebProjectService(createProfileStoreStub(), createFmClientStub(), createSchemaServiceStub(), logger);
    await service.initializeProject();
    const entries = [
      { layoutName: 'Old', fields: [' Old field '], metadataFile: 'missing.json' },
      { layoutName: 'Outside', fields: ['Keep'], metadataFile: '../../../outside.json' }
    ];
    await writeFile(service.getMetadataIndexPath(), JSON.stringify({ layoutMetadata: entries }));
    expect(await service.getDesignerLayouts()).toEqual([
      { layoutName: 'Old', fields: [{ name: ' Old field ' }], portals: [] },
      { layoutName: 'Outside', fields: [{ name: 'Keep' }], portals: [] }
    ]);
    if (process.platform !== 'win32') {
      const outside = path.join(WORKSPACE_ROOT, 'outside.json');
      await writeFile(outside, JSON.stringify({ metadata: { fields: [{ name: 'Do not read' }] } }));
      await symlink(outside, path.join(service.getMetadataLayoutsDirPath(), 'missing.json'));
      expect((await service.getDesignerLayouts())[0]?.fields).toEqual([{ name: ' Old field ' }]);
    }
  });

  it('loads a saved layout unchanged without applying any standards', async () => {
    const service = new FmWebProjectService(createProfileStoreStub(), createFmClientStub(), createSchemaServiceStub(), logger);
    const created = await service.loadOrCreateLayout();
    created.layout.canvas.gridSize = 10;
    await service.saveLayout(created.layout);
    const loaded = await service.loadOrCreateLayout(created.layout.id);
    expect(loaded.source).toBe('existing');
    expect(loaded.layout).toEqual(created.layout);
  });

  it('syncs metadata into local cache for offline usage', async () => {
    const service = new FmWebProjectService(
      createProfileStoreStub(),
      createFmClientStub({
        listLayouts: vi.fn(async () => ['Contacts']),
        listScripts: vi.fn(async () => ['Run_Startup']),
        getLayoutMetadata: vi.fn(async () => ({
          fieldMetaData: [{ name: 'FirstName' }, { name: 'LastName' }],
          tableOccurrence: 'TO_Contacts'
        }))
      }),
      createSchemaServiceStub(),
      logger
    );

    await service.initializeProject();
    const summary = await service.syncMetadata(profile);

    expect(summary.layoutCount).toBe(1);
    expect(summary.scriptCount).toBe(1);
    expect(summary.fieldCount).toBe(2);

    const cacheRaw = await readFile(path.join(WORKSPACE_ROOT, '.fmweb', 'metadata', 'index.json'), 'utf8');
    const cache = JSON.parse(cacheRaw) as { layouts: string[]; scripts: string[] };

    expect(cache.layouts).toEqual(['Contacts']);
    expect(cache.scripts).toEqual(['Run_Startup']);
  });
});

function createProfileStoreStub(): {
  setActiveProfileId: (profileId: string) => Promise<void>;
} {
  return {
    setActiveProfileId: vi.fn(async () => undefined)
  };
}

type ProjectClient = ConstructorParameters<typeof FmWebProjectService>[1];

function createFmClientStub(overrides: Partial<ProjectClient> = {}): ProjectClient {
  return {
    listLayouts: vi.fn(async () => ['Main']),
    listScripts: vi.fn(async () => []),
    getLayoutMetadata: vi.fn(async () => ({})),
    ...overrides
  };
}

function createSchemaServiceStub(): ConstructorParameters<typeof FmWebProjectService>[2] {
  return {
    getLayoutSchema: vi.fn(async () => ({ supported: true, fromCache: false, fields: [] }))
  };
}
