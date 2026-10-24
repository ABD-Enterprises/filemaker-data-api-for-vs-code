import { describe, expect, it } from 'vitest';

import { bridgeRouteRefusal } from '../../src/utils/bridgePolicy';

const allow = { getFeatureGuard: () => ({ allowed: true }) };

function config(
  values: Record<
    string,
    { defaultValue?: boolean; globalValue?: boolean; workspaceValue?: boolean }
  >
) {
  return {
    get: <T>(_key: string, fallback?: T) => fallback as T,
    inspect: (key: string) => values[key]
  } as never;
}

describe('bridge route policy', () => {
  it('refuses writes and scripts when the user turned offline mode on, even if the repository turns it off', () => {
    const offline = config({
      'offline.mode': { defaultValue: false, globalValue: true, workspaceValue: false }
    });
    expect(bridgeRouteRefusal('/editRecord', offline, allow)).toMatch(/Offline mode/);
    expect(bridgeRouteRefusal('/runScript', offline, allow)).toMatch(/Offline mode/);
    expect(bridgeRouteRefusal('/find', offline, allow)).toBeUndefined();
  });

  it('refuses scripts when the user switched the script runner off, even if the repository turns it on', () => {
    const off = config({
      'features.scriptRunner.enabled': {
        defaultValue: true,
        globalValue: false,
        workspaceValue: true
      }
    });
    expect(bridgeRouteRefusal('/runScript', off, allow)).toMatch(/disabled by the setting/);
  });

  it('follows enterprise policy for writes and scripts', () => {
    const deny = {
      getFeatureGuard: (feature: string) => ({ allowed: false, reason: `no ${feature}` })
    };
    const none = config({});
    expect(bridgeRouteRefusal('/deleteRecord', none, deny as never)).toBe('no writeOperations');
    expect(bridgeRouteRefusal('/runScript', none, deny as never)).toBe('no scriptRunner');
    expect(bridgeRouteRefusal('/getRecord', none, deny as never)).toBeUndefined();
  });

  it('refuses edit, create and delete when record editing is switched off, even if the repository turns it on', () => {
    const off = config({
      'features.recordEdit.enabled': { defaultValue: true, globalValue: false, workspaceValue: true }
    });
    for (const route of ['/editRecord', '/createRecord', '/deleteRecord']) {
      expect(bridgeRouteRefusal(route, off, allow)).toMatch(/features\.recordEdit\.enabled/);
    }
    expect(bridgeRouteRefusal('/find', off, allow)).toBeUndefined();
    expect(bridgeRouteRefusal('/getRecord', off, allow)).toBeUndefined();
    expect(bridgeRouteRefusal('/runScript', off, allow)).toBeUndefined();
  });

  it('applies the enterprise recordEdit guard to writes (viewer role) but not to reads or scripts', () => {
    const viewer = {
      getFeatureGuard: (feature: string) =>
        feature === 'recordEdit'
          ? { allowed: false, reason: 'Enterprise role "viewer" is read-only for this command.' }
          : { allowed: true }
    };
    const none = config({});
    for (const route of ['/editRecord', '/createRecord', '/deleteRecord']) {
      expect(bridgeRouteRefusal(route, none, viewer as never)).toMatch(/viewer/);
    }
    expect(bridgeRouteRefusal('/find', none, viewer as never)).toBeUndefined();
    expect(bridgeRouteRefusal('/runScript', none, viewer as never)).toBeUndefined();
  });
});
