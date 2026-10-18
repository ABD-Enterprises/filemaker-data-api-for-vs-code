import { describe, expect, it } from 'vitest';

import {
  isFeatureEnabled,
  isOfflineModeOn,
  readRestrictedSetting
} from '../../src/utils/policySetting';

function config(inspected: Record<string, unknown>) {
  return {
    get: <T>(_key: string, fallback?: T) => fallback as T,
    inspect: () => inspected
  } as never;
}

describe('restrict-only settings', () => {
  it('lets a repository switch offline mode on but never off', () => {
    expect(isOfflineModeOn(config({ defaultValue: false, workspaceValue: true }))).toBe(true);
    expect(
      isOfflineModeOn(config({ defaultValue: false, globalValue: true, workspaceValue: false }))
    ).toBe(true);
    expect(
      isOfflineModeOn(
        config({ defaultValue: false, globalValue: true, workspaceFolderValue: false })
      )
    ).toBe(true);
    expect(isOfflineModeOn(config({ defaultValue: false, workspaceValue: false }))).toBe(false);
  });

  it('lets a repository switch a feature off but never on', () => {
    const key = 'features.scriptRunner.enabled';
    expect(isFeatureEnabled(config({ defaultValue: true, workspaceValue: false }), key)).toBe(
      false
    );
    expect(
      isFeatureEnabled(
        config({ defaultValue: true, globalValue: false, workspaceValue: true }),
        key
      )
    ).toBe(false);
    expect(isFeatureEnabled(config({ defaultValue: true }), key)).toBe(true);
  });

  it('honours a remote or local user value as the baseline', () => {
    expect(
      isOfflineModeOn(
        config({ defaultValue: false, globalRemoteValue: true, workspaceValue: false })
      )
    ).toBe(true);
    expect(
      isOfflineModeOn(
        config({ defaultValue: false, globalLocalValue: true, workspaceValue: false })
      )
    ).toBe(true);
  });

  it('falls back to get() when inspect is unavailable', () => {
    const plain = {
      get: <T>(_key: string, fallback?: T) => (fallback === undefined ? undefined : true) as T
    } as never;
    expect(readRestrictedSetting(plain, 'offline.mode', false, true)).toBe(true);
  });
});
