import { describe, expect, it } from 'vitest';

import { SettingsService } from '../../../src/services/settingsService';

interface FakeStore {
  global?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
}

function fakeConfig(stores: Record<string, FakeStore> = {}): (section?: string) => never {
  return (section?: string) => {
    const store = (section && stores[section]) ?? {};
    const merged = { ...(store.global ?? {}), ...(store.workspace ?? {}) };
    return {
      get<T>(key: string, defaultValue: T): T {
        if (key in merged) {
          return merged[key] as T;
        }
        return defaultValue;
      },
      inspect<T>(key: string) {
        return {
          key,
          defaultValue: undefined,
          globalValue: store.global?.[key] as T | undefined,
          workspaceValue: store.workspace?.[key] as T | undefined,
          workspaceFolderValue: undefined
        };
      }
    } as never;
  };
}

function service(stores: Record<string, FakeStore>): SettingsService {
  return new SettingsService({
    getConfiguration: fakeConfig(stores),
    isWorkspaceTrusted: () => true
  });
}

describe('SettingsService deprecation handling', () => {
  it('prefers filemaker.requestTimeoutMs over filemakerDataApiTools.requestTimeoutMs when both are set', () => {
    const svc = service({
      filemaker: { workspace: { requestTimeoutMs: 5000 } },
      filemakerDataApiTools: { workspace: { requestTimeoutMs: 9999 } }
    });
    expect(svc.getRequestTimeoutMs()).toBe(5000);
    expect(svc.consumeDeprecatedSettingsUsed()).toEqual([]);
  });

  it('falls back to filemakerDataApiTools.requestTimeoutMs and records the deprecation', () => {
    const svc = service({
      filemakerDataApiTools: { workspace: { requestTimeoutMs: 9999 } }
    });
    expect(svc.getRequestTimeoutMs()).toBe(9999);
    expect(svc.consumeDeprecatedSettingsUsed()).toEqual([
      'filemakerDataApiTools.requestTimeoutMs'
    ]);
  });

  it('does not record deprecation when neither side is set (uses default)', () => {
    const svc = service({});
    expect(svc.getRequestTimeoutMs()).toBe(15_000);
    expect(svc.consumeDeprecatedSettingsUsed()).toEqual([]);
  });

  it('logging.level: filemaker.* wins over deprecated logLevel', () => {
    const svc = service({
      filemaker: { workspace: { 'logging.level': 'debug' } },
      filemakerDataApiTools: { workspace: { logLevel: 'error' } }
    });
    expect(svc.getLoggingLevel()).toBe('debug');
    expect(svc.consumeDeprecatedSettingsUsed()).toEqual([]);
  });

  it('logging.level falls back to deprecated logLevel and records it', () => {
    const svc = service({
      filemakerDataApiTools: { workspace: { logLevel: 'warn' } }
    });
    expect(svc.getLoggingLevel()).toBe('warn');
    expect(svc.consumeDeprecatedSettingsUsed()).toEqual([
      'filemakerDataApiTools.logLevel'
    ]);
  });

  it('multiple deprecated reads accumulate into one set, consumed once', () => {
    const svc = service({
      filemakerDataApiTools: {
        workspace: { requestTimeoutMs: 30_000, defaultApiBasePath: '/legacy/api' }
      }
    });
    svc.getRequestTimeoutMs();
    svc.getDefaultApiBasePath();
    expect(svc.consumeDeprecatedSettingsUsed().sort()).toEqual([
      'filemakerDataApiTools.defaultApiBasePath',
      'filemakerDataApiTools.requestTimeoutMs'
    ]);
    // Second consume clears
    expect(svc.consumeDeprecatedSettingsUsed()).toEqual([]);
  });

  it('normalizes the WebDirect base path setting', () => {
    const svc = service({
      filemaker: { workspace: { 'webDirect.basePath': 'custom/webd/' } }
    });
    expect(svc.getWebDirectBasePath()).toBe('/custom/webd');
  });
});
