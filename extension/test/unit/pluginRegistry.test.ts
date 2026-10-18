import { describe, expect, it, vi, beforeEach } from 'vitest';

const commandHandlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();

vi.mock('vscode', () => {
  return {
    commands: {
      registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
        commandHandlers.set(command, handler);
        return {
          dispose: () => commandHandlers.delete(command)
        };
      }),
      executeCommand: vi.fn(async () => undefined)
    },
    window: {
      registerTreeDataProvider: vi.fn(() => ({ dispose: () => undefined })),
      showInformationMessage: vi.fn(async () => undefined)
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      isTrusted: true
    }
  };
});

import { PluginRegistry } from '../../src/plugins/pluginRegistry';
import type { FileMakerPlugin } from '../../src/plugins/pluginTypes';

describe('PluginRegistry', () => {
  beforeEach(() => {
    commandHandlers.clear();
  });

  it('loads internal plugins and registers plugin commands', async () => {
    const run = vi.fn(async () => undefined);
    const plugin: FileMakerPlugin = {
      id: 'demo',
      name: 'Demo Plugin',
      activate: vi.fn(),
      commands: [
        {
          id: 'hello',
          title: 'Hello',
          run
        }
      ]
    };

    const registry = new PluginRegistry(
      {
        listProfiles: vi.fn(async () => []),
        getProfile: vi.fn(async () => undefined)
      } as never,
      {
        listLayouts: vi.fn(async () => []),
        getLayoutMetadata: vi.fn(async () => ({}))
      } as never,
      {
        getFeatureGuard: vi.fn(() => ({ allowed: true })),
        assertFeature: vi.fn(async () => true)
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      {
        internalPlugins: [plugin],
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/workspace',
        readDir: async () => []
      }
    );

    await registry.reload();

    expect(registry.listActivePlugins()).toHaveLength(1);
    const command = commandHandlers.get('filemakerDataApiTools.plugin.demo.hello');
    expect(command).toBeTypeOf('function');

    await command?.();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips workspace plugin loading in untrusted workspaces', async () => {
    const importModule = vi.fn(async () => ({
      default: {
        id: 'workspace-plugin',
        name: 'Workspace Plugin',
        activate: async () => undefined
      }
    }));

    const registry = new PluginRegistry(
      {
        listProfiles: vi.fn(async () => []),
        getProfile: vi.fn(async () => undefined)
      } as never,
      {
        listLayouts: vi.fn(async () => []),
        getLayoutMetadata: vi.fn(async () => ({}))
      } as never,
      {
        getFeatureGuard: vi.fn(() => ({ allowed: true })),
        assertFeature: vi.fn(async () => true)
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      {
        internalPlugins: [],
        isWorkspaceTrusted: () => false,
        getWorkspaceRoot: () => '/workspace',
        readDir: async () => ['demo.js'],
        importModule
      }
    );

    await registry.reload();

    expect(importModule).not.toHaveBeenCalled();
    expect(registry.listActivePlugins()).toHaveLength(0);
  });

  it('enforces requiresAdmin command restrictions', async () => {
    const run = vi.fn(async () => undefined);
    const plugin: FileMakerPlugin = {
      id: 'admin-tools',
      name: 'Admin Tools',
      activate: vi.fn(),
      commands: [
        {
          id: 'danger',
          title: 'Dangerous Command',
          requiresAdmin: true,
          run
        }
      ]
    };

    const roleGuard = {
      getFeatureGuard: vi.fn(() => ({ allowed: true })),
      assertFeature: vi.fn(async () => false)
    };

    const registry = new PluginRegistry(
      {
        listProfiles: vi.fn(async () => []),
        getProfile: vi.fn(async () => undefined)
      } as never,
      {
        listLayouts: vi.fn(async () => []),
        getLayoutMetadata: vi.fn(async () => ({}))
      } as never,
      roleGuard as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      {
        internalPlugins: [plugin],
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/workspace',
        readDir: async () => []
      }
    );

    await registry.reload();

    const command = commandHandlers.get('filemakerDataApiTools.plugin.admin-tools.danger');
    await command?.();

    expect(roleGuard.assertFeature).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  describe('workspace plugin consent', () => {
    function makeRegistry(options: {
      content: () => string;
      askConsent: (request: { fileName: string; workspaceRoot: string }) => Promise<boolean>;
      approvalState: { get: <T>(key: string, fallback?: T) => T; update: (key: string, value: unknown) => Promise<void> };
      root?: string;
      importModule: ReturnType<typeof vi.fn>;
    }): PluginRegistry {
      return new PluginRegistry(
        { listProfiles: vi.fn(async () => []), getProfile: vi.fn(async () => undefined) } as never,
        { listLayouts: vi.fn(async () => []), getLayoutMetadata: vi.fn(async () => ({})) } as never,
        { getFeatureGuard: vi.fn(() => ({ allowed: true })), assertFeature: vi.fn(async () => true) } as never,
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        {
          internalPlugins: [],
          isWorkspaceTrusted: () => true,
          getWorkspaceRoot: () => options.root ?? '/workspace',
          readDir: async () => ['demo.js', 'notes.txt'],
          readFileBytes: async () => Buffer.from(options.content()),
          importModule: options.importModule as never,
          approvalState: options.approvalState,
          askConsent: options.askConsent
        }
      );
    }

    function memento() {
      const values = new Map<string, unknown>();
      return {
        get: <T>(key: string, fallback?: T): T => (values.has(key) ? (values.get(key) as T) : (fallback as T)),
        update: async (key: string, value: unknown) => {
          values.set(key, value);
        }
      };
    }

    const pluginModule = () =>
      vi.fn(async () => ({ default: { id: 'workspace-plugin', name: 'Workspace Plugin', activate: async () => undefined } }));

    it('does not import a plugin the user declines', async () => {
      const importModule = pluginModule();
      const askConsent = vi.fn(async () => false);
      const registry = makeRegistry({ content: () => 'v1', askConsent, approvalState: memento(), importModule });

      await registry.reload();

      expect(askConsent).toHaveBeenCalledWith({ fileName: 'demo.js', workspaceRoot: '/workspace' });
      expect(importModule).not.toHaveBeenCalled();
      expect(registry.listActivePlugins()).toHaveLength(0);
    });

    it('imports an approved plugin and does not ask again for the same content', async () => {
      const importModule = pluginModule();
      const askConsent = vi.fn(async () => true);
      const state = memento();
      const registry = makeRegistry({ content: () => 'v1', askConsent, approvalState: state, importModule });

      await registry.reload();
      await registry.reload();

      expect(askConsent).toHaveBeenCalledTimes(1);
      expect(importModule).toHaveBeenCalledTimes(2);
      expect(registry.listActivePlugins().map((plugin) => plugin.id)).toEqual(['workspace-plugin']);
    });

    it('asks again when the plugin file has changed', async () => {
      const importModule = pluginModule();
      const askConsent = vi.fn(async () => true);
      let content = 'v1';
      const registry = makeRegistry({ content: () => content, askConsent, approvalState: memento(), importModule });

      await registry.reload();
      content = 'v2 with something else in it';
      await registry.reload();

      expect(askConsent).toHaveBeenCalledTimes(2);
    });

    it('asks again in a different workspace and when approval is withdrawn by declining the changed file', async () => {
      const state = memento();
      const first = makeRegistry({ content: () => 'v1', askConsent: async () => true, approvalState: state, importModule: pluginModule() });
      await first.reload();

      const askOther = vi.fn(async () => false);
      const importOther = pluginModule();
      const other = makeRegistry({ content: () => 'v1', askConsent: askOther, approvalState: state, root: '/another/repo', importModule: importOther });
      await other.reload();

      expect(askOther).toHaveBeenCalledWith({ fileName: 'demo.js', workspaceRoot: '/another/repo' });
      expect(importOther).not.toHaveBeenCalled();
    });

    it('never asks about internal plugins or non-plugin files', async () => {
      const importModule = pluginModule();
      const askConsent = vi.fn(async () => true);
      const registry = makeRegistry({ content: () => 'v1', askConsent, approvalState: memento(), importModule });

      await registry.reload();

      expect(askConsent).toHaveBeenCalledTimes(1); // demo.js only, not notes.txt
    });
  });
});
