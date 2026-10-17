import { describe, expect, it } from 'vitest';

import { SettingsService } from '../../src/services/settingsService';

type ConfigMap = Record<string, Record<string, unknown>>;

function createSettings(overrides?: ConfigMap, trusted = true): SettingsService {
  const data: ConfigMap = overrides ?? {};

  return new SettingsService({
    getConfiguration: (section?: string) =>
      ({
        get: <T>(key: string, defaultValue?: T): T => {
          const sectionData = section ? (data[section] ?? {}) : {};
          const value = sectionData[key] as T | undefined;
          return value ?? (defaultValue as T);
        },
        // Mirrors VS Code's WorkspaceConfiguration.inspect so SettingsService.getPreferred
        // can distinguish "explicitly set" from "default" in this mock. We treat any
        // present key as workspace-scoped because the test ConfigMap doesn't model scopes.
        inspect: <T>(key: string) => {
          const sectionData = section ? (data[section] ?? {}) : {};
          const value = sectionData[key] as T | undefined;
          return {
            key,
            defaultValue: undefined as T | undefined,
            globalValue: undefined as T | undefined,
            workspaceValue: value,
            workspaceFolderValue: undefined as T | undefined
          };
        }
      }) as never,
    isWorkspaceTrusted: () => trusted
  });
}

describe('SettingsService', () => {
  it('uses defaults when values are missing', () => {
    const settings = createSettings();
    expect(settings.getLoggingLevel()).toBe('info');
    expect(settings.getRequestTimeoutMs()).toBe(15_000);
    expect(settings.getSavedQueriesScope()).toBe('workspace');
    expect(settings.getTypegenOutputDir()).toBe('filemaker-types');
    expect(settings.getContainerUploadMaxBytes()).toBe(100 * 1024 * 1024);
  });

  it('normalizes invalid values', () => {
    const settings = createSettings({
      filemaker: {
        'logging.level': 'verbose',
        'savedQueries.scope': 'bad',
        'batch.concurrency': 99,
        containerUploadMaxBytes: 0,
        'typegen.outputDir': '../outside'
      },
      filemakerDataApiTools: {
        requestTimeoutMs: 10
      }
    });

    expect(settings.getLoggingLevel()).toBe('info');
    expect(settings.getSavedQueriesScope()).toBe('workspace');
    expect(settings.getBatchConcurrency()).toBe(10);
    expect(settings.getRequestTimeoutMs()).toBe(1_000);
    expect(settings.getTypegenOutputDir()).toBe('filemaker-types');
    expect(settings.getContainerUploadMaxBytes()).toBe(1);
  });

  it('clamps container upload max bytes to a safe upper bound', () => {
    const settings = createSettings({
      filemaker: {
        containerUploadMaxBytes: Number.MAX_SAFE_INTEGER
      }
    });

    expect(settings.getContainerUploadMaxBytes()).toBe(2_147_483_647);
  });

  it('forces workspaceState storage in untrusted workspaces', () => {
    const settings = createSettings(
      {
        filemaker: {
          'schema.snapshots.storage': 'workspaceFiles'
        }
      },
      false
    );

    expect(settings.getSchemaSnapshotsStorage()).toBe('workspaceState');
  });
});

describe('SettingsService.migrateDeprecatedSettings', () => {
  type Scoped = { globalValue?: unknown; workspaceValue?: unknown };
  type Store = Record<string, Record<string, Scoped>>;

  function createMigratableSettings(store: Store): {
    settings: SettingsService;
    updates: Array<[string, string, unknown, number]>;
  } {
    const updates: Array<[string, string, unknown, number]> = [];
    const settings = new SettingsService({
      getConfiguration: (section?: string) =>
        ({
          get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
          inspect: (key: string) => ({ key, ...(store[section ?? '']?.[key] ?? {}) }),
          update: async (key: string, value: unknown, target: number) => {
            updates.push([section ?? '', key, value, target]);
            const sectionStore = (store[section ?? ''] ??= {});
            const scoped = (sectionStore[key] ??= {});
            if (target === 1) {
              scoped.globalValue = value;
            } else {
              scoped.workspaceValue = value;
            }
          }
        }) as never,
      isWorkspaceTrusted: () => true
    });
    return { settings, updates };
  }

  it('moves legacy values to the new keys per scope and clears the legacy keys', async () => {
    const store: Store = {
      filemakerDataApiTools: {
        logLevel: { globalValue: 'debug' },
        requestTimeoutMs: { workspaceValue: 30000 }
      },
      filemaker: {}
    };
    const { settings, updates } = createMigratableSettings(store);

    const migrated = await settings.migrateDeprecatedSettings();

    expect(migrated.sort()).toEqual(['filemakerDataApiTools.logLevel', 'filemakerDataApiTools.requestTimeoutMs']);
    expect(store.filemaker?.['logging.level']?.globalValue).toBe('debug');
    expect(store.filemaker?.requestTimeoutMs?.workspaceValue).toBe(30000);
    expect(store.filemakerDataApiTools?.logLevel?.globalValue).toBeUndefined();
    expect(store.filemakerDataApiTools?.requestTimeoutMs?.workspaceValue).toBeUndefined();
    expect(updates).toHaveLength(4);
  });

  it('keeps an explicitly set new value and still clears the legacy one', async () => {
    const store: Store = {
      filemakerDataApiTools: { defaultApiBasePath: { globalValue: '/old' } },
      filemaker: { defaultApiBasePath: { globalValue: '/new' } }
    };
    const { settings } = createMigratableSettings(store);

    await settings.migrateDeprecatedSettings();

    expect(store.filemaker?.defaultApiBasePath?.globalValue).toBe('/new');
    expect(store.filemakerDataApiTools?.defaultApiBasePath?.globalValue).toBeUndefined();
  });

  it('does not copy a legacy value that the new key in another scope already overrides', async () => {
    const store: Store = {
      filemakerDataApiTools: { requestTimeoutMs: { workspaceValue: 60000 } },
      filemaker: { requestTimeoutMs: { globalValue: 20000 } }
    };
    const { settings } = createMigratableSettings(store);

    await settings.migrateDeprecatedSettings();

    expect(store.filemaker?.requestTimeoutMs).toEqual({ globalValue: 20000 });
    expect(store.filemakerDataApiTools?.requestTimeoutMs?.workspaceValue).toBeUndefined();
  });

  it('does nothing when no legacy keys are set', async () => {
    const { settings, updates } = createMigratableSettings({ filemakerDataApiTools: {}, filemaker: {} });
    expect(await settings.migrateDeprecatedSettings()).toEqual([]);
    expect(updates).toEqual([]);
  });
});
