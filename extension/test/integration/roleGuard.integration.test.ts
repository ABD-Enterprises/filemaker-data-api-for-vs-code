import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  return {
    workspace: {
      getConfiguration: () => ({
        get: () => undefined
      })
    },
    commands: {
      executeCommand: vi.fn(async () => undefined)
    },
    env: {
      openExternal: vi.fn(async () => true)
    },
    window: {
      showWarningMessage: vi.fn(async () => undefined)
    },
    Uri: {
      parse: (value: string) => ({ toString: () => value })
    }
  };
});

import { RoleGuard } from '../../src/enterprise/roleGuard';

function createConfiguration(values: Record<string, unknown>) {
  return {
    get<T>(key: string, fallback?: T): T {
      if (key in values) {
        return values[key] as T;
      }

      return fallback as T;
    },
    update: vi.fn(async () => undefined)
  };
}

describe('role guard integration', () => {
  it('blocks restricted features for viewer role', async () => {
    const guard = new RoleGuard(
      {
        debug: vi.fn(),
        warn: vi.fn()
      },
      {
        getConfiguration: () =>
          createConfiguration({
            'enterprise.mode': true,
            'enterprise.role': 'viewer',
            'offline.mode': false
          }) as never,
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/workspace',
        readConfigFile: async () => undefined
      }
    );

    await guard.refresh();

    expect(guard.getFeatureGuard('recordEdit').allowed).toBe(false);
    expect(guard.getFeatureGuard('batchUpdate').allowed).toBe(false);
    expect(guard.getFeatureGuard('environmentExport').allowed).toBe(false);
    expect(guard.getFeatureGuard('pluginInstall').allowed).toBe(false);
  });
});
