import { readFileSync } from 'fs';
import { join } from 'path';

import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

import {
  BADGE_STRICTER,
  BADGE_USER_ONLY,
  BADGE_WORKSPACE,
  EMPTY_NOTICE_STATE,
  POLICY_SETTINGS,
  badgeFor,
  explainSetting,
  noticeMessage,
  parseFilemakerSettings,
  pickNotices,
  policyFor,
  type PolicySetting
} from '../../src/settings/settingPolicy';
import {
  collectExplanations,
  openSettingsTab,
  renderEffectiveSettingsHtml
} from '../../src/settings/effectiveSettings';
import { readRestrictedSetting } from '../../src/utils/policySetting';

const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
  contributes: {
    commands: Array<{ command: string; title: string; category: string }>;
    configuration: Array<{ properties: Record<string, Record<string, unknown>> }>;
  };
};

/** A configuration whose `inspect` reports the given scope values, like VS Code does. */
const fakeConfig = (key: string, values: { user?: unknown; workspace?: unknown; def?: unknown }) => ({
  get: (name: string, fallback?: unknown) => (name === key ? (values.workspace ?? values.user ?? values.def) : fallback),
  inspect: (name: string) =>
    name === key
      ? { key, defaultValue: values.def, globalValue: values.user, workspaceValue: values.workspace }
      : undefined
});

const OPTIONS: Array<boolean | undefined> = [true, false, undefined];

describe('explainSetting for restrict-only switches', () => {
  for (const restrictedValue of [true, false]) {
    for (const user of OPTIONS) {
      for (const workspace of OPTIONS) {
        it(`restricted=${restrictedValue} user=${String(user)} workspace=${String(workspace)}`, () => {
          const def = !restrictedValue;
          const setting: PolicySetting = { key: 'x.switch', kind: 'stricter-bool', restrictedValue };
          const config = fakeConfig('x.switch', { user, workspace, def });
          // The effective value comes from the reader that enforces the rule.
          const effective = readRestrictedSetting(config as never, 'x.switch', def, restrictedValue);
          const result = explainSetting({
            setting,
            values: { default: def, user, workspace },
            effective,
            trusted: true,
            restrictedInUntrusted: false
          });
          const baseline = user ?? def;

          expect(result.effective).toBe(effective);
          expect(result.ignored).toBe(workspace !== undefined && workspace !== effective);
          if (workspace === !restrictedValue && baseline === restrictedValue) {
            expect(result.reason).toContain(`sets x.switch to ${String(workspace)}`);
            expect(result.reason).toContain(`${user === undefined ? 'default' : 'User'} value is ${String(baseline)}`);
            expect(result.reason).toContain(`a workspace can only turn it ${restrictedValue ? 'on' : 'off'}`);
            expect(result.source).toBe(user === undefined ? 'Default' : 'User');
          } else {
            expect(result.ignored).toBe(false);
          }
          if (workspace === restrictedValue && baseline !== restrictedValue) {
            expect(result.source).toBe('Workspace');
          }
          expect(result.workspaceMeaningful).toBe(true);
        });
      }
    }
  }

  it('says it plainly for offline mode', () => {
    const result = explainSetting({
      setting: policyFor('offline.mode') as PolicySetting,
      values: { default: false, user: true, workspace: false },
      effective: true,
      trusted: true,
      restrictedInUntrusted: true
    });
    expect(result.reason).toBe(
      'This workspace sets offline.mode to false but your User value is true, and a workspace can only turn it on, so it stays on.'
    );
  });
});

describe('explainSetting for other kinds', () => {
  it('flags a workspace value for a user-only setting as ignored, even though VS Code hides it', () => {
    const result = explainSetting({
      setting: policyFor('ai.enabled') as PolicySetting,
      values: { default: false, user: false, workspaceFile: true },
      effective: false,
      trusted: true,
      restrictedInUntrusted: false
    });
    expect(result.ignored).toBe(true);
    expect(result.noticeWorthy).toBe(true);
    expect(result.reason).toContain('only works in User settings');
    expect(result.workspaceMeaningful).toBe(false);
  });

  it('does not call an ignored value worth a notice when it equals what is in effect', () => {
    const result = explainSetting({
      setting: policyFor('ai.enabled') as PolicySetting,
      values: { default: false, user: false, workspaceFile: false },
      effective: false,
      trusted: true,
      restrictedInUntrusted: false
    });
    expect(result.ignored).toBe(true);
    expect(result.noticeWorthy).toBe(false);
  });

  it('lets a workspace lower the enterprise role but not raise it', () => {
    const setting = policyFor('enterprise.role') as PolicySetting;
    const lower = explainSetting({
      setting, values: { default: 'developer', user: 'admin', workspace: 'viewer' },
      effective: 'viewer', trusted: true, restrictedInUntrusted: true
    });
    expect(lower.ignored).toBe(false);
    expect(lower.source).toBe('Workspace');
    const raise = explainSetting({
      setting, values: { default: 'developer', user: 'viewer', workspace: 'admin' },
      effective: 'viewer', trusted: true, restrictedInUntrusted: true
    });
    expect(raise.ignored).toBe(true);
    expect(raise.reason).toContain('can only lower the role');
  });

  it('reports Restricted Mode for a workspace value VS Code or the code will not use', () => {
    const outputDir = explainSetting({
      setting: policyFor('typegen.outputDir') as PolicySetting,
      values: { default: 'filemaker-types', workspace: 'src/types' },
      effective: 'filemaker-types', trusted: false, restrictedInUntrusted: true
    });
    expect(outputDir.source).toBe('Restricted Mode');
    expect(outputDir.ignored).toBe(true);
    const trusted = explainSetting({
      setting: policyFor('typegen.outputDir') as PolicySetting,
      values: { default: 'filemaker-types', workspace: 'src/types' },
      effective: 'src/types', trusted: true, restrictedInUntrusted: true
    });
    expect(trusted.source).toBe('Workspace');
    expect(trusted.ignored).toBe(false);
    const snapshots = explainSetting({
      setting: policyFor('schema.snapshots.storage') as PolicySetting,
      values: { default: 'workspaceFiles', workspace: 'workspaceFiles' },
      effective: 'workspaceState', trusted: false, restrictedInUntrusted: false
    });
    expect(snapshots.source).toBe('Restricted Mode');
  });
});

describe('notification de-duplication', () => {
  const ignoredEntry = explainSetting({
    setting: policyFor('offline.mode') as PolicySetting,
    values: { default: false, user: true, workspace: false },
    effective: true, trusted: true, restrictedInUntrusted: true
  });
  const harmless = explainSetting({
    setting: policyFor('ai.enabled') as PolicySetting,
    values: { default: false, user: false, workspaceFile: false },
    effective: false, trusted: true, restrictedInUntrusted: false
  });

  it('announces a setting once, then never again', () => {
    const first = pickNotices([ignoredEntry], EMPTY_NOTICE_STATE);
    expect(first.show).toHaveLength(1);
    const second = pickNotices([ignoredEntry], first.next);
    expect(second.show).toHaveLength(0);
  });

  it('stays quiet once muted and when the ignored value equals the one in effect', () => {
    expect(pickNotices([ignoredEntry], { seen: [], muted: true }).show).toHaveLength(0);
    expect(pickNotices([harmless], EMPTY_NOTICE_STATE).show).toHaveLength(0);
  });

  it('words one or several settings in a single message', () => {
    expect(noticeMessage([ignoredEntry])).toContain('stays on');
    expect(noticeMessage([ignoredEntry, ignoredEntry])).toContain('2 settings that are ignored');
  });
});

describe('settings file parsing', () => {
  it('reads filemaker.* keys from JSONC with comments and trailing commas', () => {
    const text = `{
      // a comment with "quotes" and a , comma
      "editor.fontSize": 12,
      "filemaker.ai.enabled": true, /* block */
      "filemaker.note": "http://x//y, }",
      "filemaker.ai.hiddenFields": ["a", "b",],
    }`;
    expect(parseFilemakerSettings(text)).toEqual({
      'ai.enabled': true,
      note: 'http://x//y, }',
      'ai.hiddenFields': ['a', 'b']
    });
    expect(parseFilemakerSettings('not json')).toEqual({});
  });
});

describe('Effective Settings view', () => {
  it('shows the Workspace button only where a workspace value matters, and escapes values', () => {
    const rows = [
      explainSetting({
        setting: policyFor('ai.enabled') as PolicySetting,
        values: { default: false }, effective: false, trusted: true, restrictedInUntrusted: false
      }),
      explainSetting({
        setting: policyFor('typegen.outputDir') as PolicySetting,
        values: { default: '<img src=x>' }, effective: '<img src=x>', trusted: true, restrictedInUntrusted: true
      })
    ];
    const html = renderEffectiveSettingsHtml(rows, "default-src 'none'", 'N');
    expect(html).not.toContain('<img src=x>');
    expect(html.match(/data-open="workspace"/g)).toHaveLength(1);
    expect(html.match(/data-open="user"/g)).toHaveLength(2);
  });

  it('opens the User and Workspace tabs with the setting id', async () => {
    const execute = vi.mocked(vscode.commands.executeCommand);
    execute.mockClear();
    await openSettingsTab('user', 'filemaker.ai.enabled');
    await openSettingsTab('workspace', 'filemaker.typegen.outputDir');
    expect(execute).toHaveBeenNthCalledWith(1, 'workbench.action.openGlobalSettings', { query: '@id:filemaker.ai.enabled' });
    expect(execute).toHaveBeenNthCalledWith(2, 'workbench.action.openWorkspaceSettings', { query: '@id:filemaker.typegen.outputDir' });
  });

  it('computes the effective value with the enforcing reader (offline mode: User true beats Workspace false)', async () => {
    const config = {
      ...fakeConfig('offline.mode', { user: true, workspace: false, def: false }),
      inspect: (name: string) =>
        name === 'offline.mode' ? { key: name, defaultValue: false, globalValue: true, workspaceValue: false } : undefined
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(config as never);
    const rows = await collectExplanations({
      context: { extension: { packageJSON: manifest } } as never,
      roleGuard: { getRole: () => 'developer', getEnterpriseFileSettings: () => ({}) } as never,
      settingsService: {
        getSavedQueriesScope: () => 'workspace',
        getTypegenOutputDir: () => 'filemaker-types',
        getSchemaSnapshotsStorage: () => 'workspaceFiles'
      } as never
    });
    const offline = rows.find((row) => row.key === 'filemaker.offline.mode');
    expect(offline).toMatchObject({ effective: true, source: 'User', ignored: true, noticeWorthy: true });
    expect(rows).toHaveLength(POLICY_SETTINGS.length);
  });
});

describe('package.json setting descriptions', () => {
  const properties = manifest.contributes.configuration.flatMap((section) => Object.entries(section.properties));
  const restricted = new Set(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations);
  const badges = [BADGE_USER_ONLY, BADGE_STRICTER, BADGE_WORKSPACE];

  it('gives every setting exactly one badge, at the start, that matches how the code treats it', () => {
    expect(properties.length).toBeGreaterThan(40);
    for (const [key, schema] of properties) {
      const text = String(schema.markdownDescription ?? '');
      expect(schema.description, `${key} uses markdownDescription so the badge renders`).toBeUndefined();
      expect(badges.filter((badge) => text.includes(badge)), key).toHaveLength(1);
      const kind = policyFor(key)?.kind;
      expect(text.startsWith(badgeFor(kind)), key).toBe(true);
      if (schema.scope === 'application') {
        expect(kind, `${key} is application scope`).toBe('user-only');
      } else {
        expect(kind === 'user-only', `${key} is not application scope`).toBe(false);
      }
      if (kind && kind.startsWith('stricter') && key !== 'filemaker.ai.hiddenFields') {
        expect(restricted.has(key), `${key} is a restricted configuration`).toBe(true);
      }
    }
  });

  it('lists only real settings in the registry', () => {
    const keys = new Set(properties.map(([key]) => key));
    for (const setting of POLICY_SETTINGS) {
      expect(keys.has(`filemaker.${setting.key}`), setting.key).toBe(true);
    }
  });

  it('explains the saved-query, snapshot and type-output settings', () => {
    const byKey = Object.fromEntries(properties);
    expect(byKey['filemaker.savedQueries.scope']?.enum).toEqual(['workspace', 'global']);
    expect(byKey['filemaker.savedQueries.scope']?.enumDescriptions).toEqual([
      'workspace: saved with this project (other projects do not see them)',
      'global: available in every project on this computer'
    ]);
    expect(String(byKey['filemaker.schema.snapshots.storage']?.markdownDescription)).toContain('.vscode/filemaker/snapshots');
    expect(String(byKey['filemaker.typegen.outputDir']?.markdownDescription)).toContain('relative to the project folder');
  });
});

describe('Show Effective Settings command', () => {
  it('is contributed under the FileMaker category, always in the palette, and registered', () => {
    const command = manifest.contributes.commands.find((entry) => entry.command === 'filemakerDataApiTools.showEffectiveSettings');
    expect(command).toMatchObject({ title: 'Show Effective Settings', category: 'FileMaker' });
    expect(readFileSync(join(root, 'src/settings/effectiveSettings.ts'), 'utf8')).toContain(
      "SHOW_EFFECTIVE_SETTINGS = 'filemakerDataApiTools.showEffectiveSettings'"
    );
    expect(readFileSync(join(root, 'src/extension.ts'), 'utf8')).toContain('registerEffectiveSettings(');
  });

  it('opens the User tab for the AI settings action', () => {
    expect(readFileSync(join(root, 'src/commands/aiTools.ts'), 'utf8')).toContain("'workbench.action.openGlobalSettings'");
  });
});
