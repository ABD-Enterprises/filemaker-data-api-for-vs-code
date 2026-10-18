import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerOfflineCommands } from '../../src/commands/offline';
import { OfflineModeService } from '../../src/offline/offlineModeService';

interface Scopes {
  globalValue?: boolean;
  workspaceValue?: boolean;
  workspaceFolderValue?: boolean;
  globalRemoteValue?: boolean;
}

/** A settings object whose `update` really changes the scope it is given. */
function makeConfiguration(initial: Scopes) {
  const scopes: Scopes = { ...initial };
  const update = vi.fn(async (_key: string, value: boolean, target: number) => {
    if (target === vscode.ConfigurationTarget.Global) scopes.globalValue = value;
    else if (target === vscode.ConfigurationTarget.Workspace) scopes.workspaceValue = value;
    else throw new Error('Unable to write to Workspace Settings because no workspace is opened.');
  });
  return {
    update,
    scopes,
    configuration: {
      get: (_key: string, fallback?: boolean) => scopes.globalValue ?? fallback,
      inspect: () => ({ key: 'offline.mode', defaultValue: false, ...scopes }),
      update
    }
  };
}

function makeService(initial: Scopes) {
  const settings = makeConfiguration(initial);
  const service = new OfflineModeService({ warn: vi.fn() }, {
    getWorkspaceRoot: () => undefined,
    getConfiguration: () => settings.configuration as never
  });
  return { service, ...settings };
}

describe('OfflineModeService.toggleOfflineMode', () => {
  it('writes the user scope, never the workspace, so it works with no folder open', async () => {
    const { service, update, scopes } = makeService({});

    const result = await service.toggleOfflineMode();

    expect(result).toEqual({ requested: true, effective: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('offline.mode', true, vscode.ConfigurationTarget.Global);
    expect(scopes.workspaceValue).toBeUndefined();
  });

  it('turns an offline mode set in user settings off', async () => {
    const { service } = makeService({ globalValue: true });
    expect(await service.toggleOfflineMode()).toEqual({ requested: false, effective: false });
  });

  it('reports that a workspace setting keeps offline mode on', async () => {
    const { service } = makeService({ globalValue: false, workspaceValue: true });
    expect(await service.toggleOfflineMode(false)).toEqual({
      requested: false,
      effective: true,
      keptOnBy: 'the workspace settings'
    });
  });

  it('names the workspace folder as the source when it is the one keeping it on', async () => {
    expect((await makeService({ workspaceFolderValue: true }).service.toggleOfflineMode(false)).keptOnBy).toBe(
      'the workspace folder settings'
    );
  });
});

describe('Toggle Offline Mode command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function run(initial: Scopes): Promise<string> {
    const { service } = makeService(initial);
    registerOfflineCommands({
      profileStore: {} as never,
      fmClient: {} as never,
      offlineModeService: service,
      roleGuard: { applyContexts: vi.fn(async () => undefined) } as never,
      logger: { warn: vi.fn(), error: vi.fn() } as never,
      refreshExplorer: vi.fn()
    });
    const handler = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([id]) => id === 'filemakerDataApiTools.toggleOfflineMode')?.[1] as () => Promise<void>;
    await handler();
    return String(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]);
  }

  it('says enabled / disabled for a plain toggle', async () => {
    expect(await run({})).toBe('Offline mode enabled.');
    expect(await run({ globalValue: true })).toBe('Offline mode disabled.');
  });

  it('does not claim it is disabled when a workspace setting keeps it on', async () => {
    const message = await run({ globalValue: true, workspaceValue: true });
    expect(message).toContain('still on because of the workspace settings');
    expect(message).not.toContain('disabled');
  });
});
