import { describe, expect, it } from 'vitest';

import { readUserScopeString, readUserScopeValue } from '../../src/utils/userScopeSetting';

type Inspected = Record<string, unknown>;

function configuration(inspected: Inspected | undefined, merged?: unknown) {
  return {
    inspect: () => inspected,
    get: () => merged
  } as never;
}

describe('readUserScopeString', () => {
  it('returns the user (global) value', () => {
    expect(readUserScopeString(configuration({ globalValue: 'docs/ai.md' }), 'ai.contextPath')).toBe('docs/ai.md');
  });

  it('ignores workspace and workspace-folder values', () => {
    expect(
      readUserScopeString(
        configuration({ workspaceValue: '../../evil.md', workspaceFolderValue: '/etc/x' }),
        'ai.contextPath'
      )
    ).toBeUndefined();
  });

  it('ignores a fake dev-container (remote) value and a local value', () => {
    expect(
      readUserScopeString(
        configuration({ globalRemoteValue: '.git/hooks/pre-commit', globalLocalValue: 'x.md', defaultValue: '' }),
        'ai.contextPath'
      )
    ).toBeUndefined();
  });

  it('prefers the user value when every scope is set', () => {
    expect(
      readUserScopeString(
        configuration({
          globalValue: 'mine.md',
          workspaceValue: 'repo.md',
          workspaceFolderValue: 'folder.md',
          globalRemoteValue: 'remote.md',
          globalLocalValue: 'local.md'
        }),
        'ai.contextPath'
      )
    ).toBe('mine.md');
  });

  it('treats blank and non-string user values as unset', () => {
    expect(readUserScopeString(configuration({ globalValue: '   ' }), 'k')).toBeUndefined();
    expect(readUserScopeString(configuration({ globalValue: 7 }), 'k')).toBeUndefined();
  });

  it('fails closed when the configuration cannot say where a value came from', () => {
    expect(readUserScopeString({ get: () => '/etc/passwd' } as never, 'k')).toBeUndefined();
    expect(readUserScopeString(configuration(undefined, 'merged.md'), 'k')).toBeUndefined();
  });
});

describe('readUserScopeValue', () => {
  it('uses the validator', () => {
    const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
    expect(readUserScopeValue(configuration({ globalValue: true }), 'k', isBoolean)).toBe(true);
    expect(readUserScopeValue(configuration({ globalValue: 'true' }), 'k', isBoolean)).toBeUndefined();
  });
});
