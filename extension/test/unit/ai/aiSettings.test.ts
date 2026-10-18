import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { isAiFeatureSwitchOn, isExternalServerEnabled, readAiSettings } from '../../../src/ai/aiSettings';

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

  it('hiddenFields: a bare string is read as one name and a non-list, non-text value is ignored, both reported', () => {
    const problems: unknown[] = [];
    const settings = readAiSettings(
      configuration({
        'ai.hiddenFields': { globalValue: 'Salary', workspaceValue: { a: 1 }, workspaceFolderValue: ['SSN'] }
      }),
      (problem) => problems.push(problem)
    );
    expect(settings.hiddenFields.sort()).toEqual(['SSN', 'Salary']);
    expect(problems).toEqual([
      { scope: 'globalValue', kind: 'single-name', count: 1 },
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
