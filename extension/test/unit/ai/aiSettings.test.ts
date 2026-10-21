import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { createHiddenFieldsWarner, isAiFeatureSwitchOn, isExternalServerEnabled, readAiSettings } from '../../../src/ai/aiSettings';

function configuration(values: Record<string, Record<string, unknown>>) {
  return {
    inspect: (key: string) => values[key],
    get: (key: string, fallback?: unknown) => {
      const entry = values[key];
      return entry?.workspaceValue ?? entry?.globalValue ?? entry?.defaultValue ?? fallback;
    }
  } as never;
}

describe('readAiSettings', () => {
  it('reads widening settings from the user value only', () => {
    const settings = readAiSettings(
      configuration({
        'ai.enabled': { globalValue: true },
        'ai.allowWrites': { globalValue: true },
        'ai.allowScripts': { globalValue: true },
        'ai.connection': { globalValue: ' p1 ' },
        'ai.scriptAllowlist': { globalValue: { p1: ['A'] } },
        'ai.readableLayouts': { globalValue: { p1: ['L'] } }
      })
    );
    expect(settings).toMatchObject({
      enabled: true,
      allowWrites: true,
      allowScripts: true,
      connection: 'p1',
      scriptAllowlist: { p1: ['A'] },
      readableLayouts: { p1: ['L'] }
    });
  });

  it('ignores workspace, folder, dev-container (remote) and local values for every widening setting', () => {
    const hostile = {
      workspaceValue: true,
      workspaceFolderValue: true,
      globalRemoteValue: true,
      globalLocalValue: true,
      defaultValue: false
    };
    const settings = readAiSettings(
      configuration({
        'ai.enabled': hostile,
        'ai.allowWrites': hostile,
        'ai.allowScripts': hostile,
        'ai.connection': { workspaceValue: 'evil', globalRemoteValue: 'evil' },
        'ai.scriptAllowlist': { workspaceValue: { p1: ['Evil'] }, globalRemoteValue: { p1: ['Evil'] } },
        'ai.readableLayouts': { workspaceValue: { p1: ['Evil'] }, globalRemoteValue: { p1: ['Evil'] } }
      })
    );
    expect(settings).toEqual({
      enabled: false,
      allowWrites: false,
      allowScripts: false,
      scriptAllowlist: {},
      readableLayouts: {},
      hiddenFields: [],
      connection: undefined
    });
  });

  it('fails closed when the configuration cannot say where a value came from', () => {
    const settings = readAiSettings({ get: () => true } as never);
    expect(settings.enabled).toBe(false);
    expect(settings.connection).toBeUndefined();
  });

  it('treats values of the wrong type as unset', () => {
    const settings = readAiSettings(
      configuration({
        'ai.enabled': { globalValue: 'true' },
        'ai.scriptAllowlist': { globalValue: { p1: 'Archive' } },
        'ai.readableLayouts': { globalValue: ['x'] }
      })
    );
    expect(settings.enabled).toBe(false);
    expect(settings.scriptAllowlist).toEqual({});
    expect(settings.readableLayouts).toEqual({});
  });

  it('hiddenFields only grows: a workspace adds names, and cannot remove the user\'s', () => {
    const settings = readAiSettings(
      configuration({
        'ai.hiddenFields': {
          globalValue: ['Salary'],
          workspaceValue: ['SSN'],
          workspaceFolderValue: ['Phone'],
          globalRemoteValue: ['Dob']
        }
      })
    );
    expect(settings.hiddenFields.sort()).toEqual(['Dob', 'Phone', 'SSN', 'Salary']);

    const replaced = readAiSettings(configuration({ 'ai.hiddenFields': { globalValue: ['Salary'], workspaceValue: [] } }));
    expect(replaced.hiddenFields).toEqual(['Salary']);
  });

  it('hiddenFields fails closed: a non-text entry is ignored and reported, the valid names in the list still hide', () => {
    const problems: unknown[] = [];
    const settings = readAiSettings(
      configuration({
        'ai.hiddenFields': {
          globalValue: ['Salary', 42, 'SSN', null, { name: 'x' }],
          workspaceValue: ['Phone']
        }
      }),
      (problem) => problems.push(problem)
    );
    expect(settings.hiddenFields.sort()).toEqual(['Phone', 'SSN', 'Salary']);
    expect(problems).toEqual([{ scope: 'globalValue', kind: 'entries-ignored', count: 3 }]);
  });

  it('hiddenFields: a bare string still hides one exact name and warns, while array names stay exact', () => {
    const problems: unknown[] = [];
    const settings = readAiSettings(
      configuration({
        'ai.hiddenFields': { globalValue: 'SSN, Password', workspaceValue: { a: 1 }, workspaceFolderValue: [' SSN ', 'Password'] }
      }),
      (problem) => problems.push(problem)
    );
    expect(settings.hiddenFields.sort()).toEqual([' SSN ', 'Password', 'SSN, Password']);
    expect(problems).toEqual([
      { scope: 'globalValue', kind: 'string-as-name', count: 1 },
      { scope: 'workspaceValue', kind: 'value-ignored', count: 1 }
    ]);
  });

  it('hiddenFields reports nothing for a clean list', () => {
    const problems: unknown[] = [];
    readAiSettings(configuration({ 'ai.hiddenFields': { globalValue: ['A'], workspaceValue: [] } }), (p) => problems.push(p));
    expect(problems).toEqual([]);
  });
});

describe('isAiFeatureSwitchOn (restrict-only)', () => {
  it('is on by default, off when a workspace turns it off, and a workspace cannot turn on what the user turned off', () => {
    expect(isAiFeatureSwitchOn(configuration({}))).toBe(true);
    expect(isAiFeatureSwitchOn(configuration({ 'features.ai.enabled': { workspaceValue: false } }))).toBe(false);
    expect(isAiFeatureSwitchOn(configuration({ 'features.ai.enabled': { globalValue: false, workspaceValue: true } }))).toBe(false);
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: Array<{ properties: Record<string, { scope?: string; default?: unknown }> }> };
    capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
  };
  const properties = Object.assign({}, ...manifest.contributes.configuration.map((section) => section.properties)) as Record<
    string,
    { scope?: string; default?: unknown }
  >;

  it('declares every setting that widens AI use as application-scoped, with a safe default', () => {
    for (const key of ['enabled', 'allowWrites', 'allowScripts', 'scriptAllowlist', 'readableLayouts', 'connection']) {
      expect(properties[`filemaker.ai.${key}`]?.scope, key).toBe('application');
    }
    expect(properties['filemaker.ai.enabled']?.default).toBe(false);
    expect(properties['filemaker.ai.allowWrites']?.default).toBe(false);
    expect(properties['filemaker.ai.allowScripts']?.default).toBe(false);
    expect(properties['filemaker.ai.scriptAllowlist']?.default).toEqual({});
  });

  it('declares the external (MCP) server setting as application-scoped and off by default', () => {
    expect(properties['filemaker.ai.externalServer.enabled']?.scope).toBe('application');
    expect(properties['filemaker.ai.externalServer.enabled']?.default).toBe(false);
  });

  it('lets a workspace add hidden fields (not application-scoped) and switch AI off', () => {
    expect(properties['filemaker.ai.hiddenFields']?.scope).toBeUndefined();
    expect(properties['filemaker.features.ai.enabled']?.default).toBe(true);
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain('filemaker.features.ai.enabled');
  });
});

describe('isExternalServerEnabled', () => {
  it('reads the user value only: workspace, folder and dev-container values cannot start the server', () => {
    expect(isExternalServerEnabled(configuration({ 'ai.externalServer.enabled': { globalValue: true } }))).toBe(true);
    expect(
      isExternalServerEnabled(
        configuration({ 'ai.externalServer.enabled': { workspaceValue: true, workspaceFolderValue: true, globalRemoteValue: true, globalLocalValue: true, defaultValue: false } })
      )
    ).toBe(false);
    expect(isExternalServerEnabled({ get: () => true } as never)).toBe(false);
    expect(isExternalServerEnabled(configuration({ 'ai.externalServer.enabled': { globalValue: 'true' } }))).toBe(false);
  });
});

describe('createHiddenFieldsWarner', () => {
  const fix = 'Fix the setting to a list of field names, for example ["SSN", "Password"].';

  it.each([
    [' SSN, Password ', [' SSN, Password '], 'the value is a string, so it still hides one exact field name (commas are not separators)'],
    ['', [''], 'the value is a string, so it still hides one exact field name (commas are not separators)'],
    [[' Exact ', 42], [' Exact '], '1 entry is not text and was ignored; the other names still hide'],
    [[' Exact ', null, false], [' Exact '], '2 entries are not text and were ignored; the other names still hide'],
    [{}, [], 'the value is not a list of names and was ignored']
  ])('warns for %j while retaining valid names and other scopes', (value, names, problem) => {
    const warn = vi.fn();
    const report = createHiddenFieldsWarner(warn);
    const config = configuration({ 'ai.hiddenFields': { globalValue: value, workspaceValue: ['KeepHidden'] } });
    expect(readAiSettings(config, report).hiddenFields).toEqual([...names, 'KeepHidden']);
    expect(warn.mock.calls).toEqual([[`filemaker.ai.hiddenFields (globalValue): ${problem}. ${fix}`]]);
    readAiSettings(config, report);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('deduplicates by scope, kind and count across readers, with separate state for a new warner', () => {
    const warn = vi.fn();
    const report = createHiddenFieldsWarner(warn);
    const problem = { scope: 'globalValue', kind: 'entries-ignored' as const, count: 1 };
    report(problem);
    report(problem);
    report({ ...problem, scope: 'workspaceValue' });
    report({ ...problem, count: 2 });
    report({ ...problem, kind: 'string-as-name' });
    expect(warn).toHaveBeenCalledTimes(4);
    createHiddenFieldsWarner(warn)(problem);
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it.each([[], undefined, null])('does not warn for an empty or unset value %j, or remove hiding from another scope', (value) => {
    const warn = vi.fn();
    const settings = readAiSettings(configuration({
      'ai.hiddenFields': { globalValue: ['KeepHidden'], workspaceValue: value }
    }), createHiddenFieldsWarner(warn));
    expect(settings.hiddenFields).toEqual(['KeepHidden']);
    expect(warn).not.toHaveBeenCalled();
  });
});
