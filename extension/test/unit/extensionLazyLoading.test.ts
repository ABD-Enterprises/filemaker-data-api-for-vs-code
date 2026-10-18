import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const lazyModules = vi.hoisted(() => ({
  fmClientModuleLoaded: vi.fn(),
  fmClientConstructed: vi.fn(),
  createSession: vi.fn(async () => 'token'),
  batchServiceModuleLoaded: vi.fn(),
  circuitBreakerModuleLoaded: vi.fn(),
  backoffModuleLoaded: vi.fn(),
  retryWithBackoff: vi.fn(async (operation: () => Promise<unknown>) => operation())
}));

vi.mock('../../src/services/fmClient', () => {
  lazyModules.fmClientModuleLoaded();

  return {
    FMClient: class {
      public constructor(...args: unknown[]) {
        lazyModules.fmClientConstructed(...args);
      }

      public createSession = lazyModules.createSession;
      public deleteSession = async (): Promise<void> => {};
      public listLayouts = async (): Promise<string[]> => [];
      public listScripts = async (): Promise<string[]> => [];
      public getRecord = async (): Promise<Record<string, unknown>> => ({});
      public findRecords = async (): Promise<Record<string, unknown>> => ({});
      public getLayoutMetadata = async (): Promise<Record<string, unknown>> => ({});
      public editRecord = async (): Promise<Record<string, unknown>> => ({});
      public createRecord = async (): Promise<Record<string, unknown>> => ({});
      public deleteRecord = async (): Promise<Record<string, unknown>> => ({});
      public runScript = async (): Promise<Record<string, unknown>> => ({});
      public invalidateProfileCache(): void {}
      public onProfileInvalidated(): () => void {
        return () => undefined;
      }
      public onHealthChange(): () => void {
        return () => undefined;
      }
      public getHealth(): undefined {
        return undefined;
      }
      public isSignInPaused(): boolean {
        return false;
      }
      public clearAuthPause(): void {}
      public shouldRefreshSession(): boolean {
        return false;
      }
    }
  };
});

vi.mock('../../src/services/batchService', () => {
  lazyModules.batchServiceModuleLoaded();

  return {
    BatchService: class {
      public getDefaultBatchUpdateOptions(): { dryRun: boolean; concurrency: number } {
        return { dryRun: true, concurrency: 4 };
      }

      public batchExportFind = async (): Promise<Record<string, unknown>> => ({});
      public batchUpdate = async (): Promise<Record<string, unknown>> => ({});
    },
    inferExportFormat: vi.fn(() => 'jsonl'),
    parseBatchUpdateInput: vi.fn(() => [])
  };
});

vi.mock('../../src/performance/circuitBreakerRegistry', () => {
  lazyModules.circuitBreakerModuleLoaded();

  return {
    CircuitBreakerRegistry: class {
      public list(): unknown[] {
        return [];
      }

      public register(): void {}
      public recordTransition(): void {}
      public unregister(): void {}
    },
    renderCircuitBreakerStatus: vi.fn(() => '# Circuit breakers')
  };
});

vi.mock('../../src/utils/backoff', () => {
  lazyModules.backoffModuleLoaded();

  return {
    retryWithBackoff: lazyModules.retryWithBackoff
  };
});

describe('extension lazy FM runtime loading', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installActivationVsCodeMocks();
  });

  it('does not load FM client, retry, batch, or circuit-breaker modules during activation', async () => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();

    await activate(context);
    disposeSubscriptions(context);

    expect(lazyModules.fmClientModuleLoaded).not.toHaveBeenCalled();
    expect(lazyModules.backoffModuleLoaded).not.toHaveBeenCalled();
    expect(lazyModules.batchServiceModuleLoaded).not.toHaveBeenCalled();
    expect(lazyModules.circuitBreakerModuleLoaded).not.toHaveBeenCalled();
  });

  it('registers every contributed command during activation', async () => {
    // A command listed in package.json but never registered shows in menus and the
    // palette, then fails with "command not found" when run.
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);

    const registered = new Set(vi.mocked(vscode.commands.registerCommand).mock.calls.map(([id]) => id));
    disposeSubscriptions(context);

    const { contributes } = (await import('../../package.json')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    expect(contributes.commands.map(({ command }) => command).filter((id) => !registered.has(id))).toEqual([]);
  });

  it('shows the installed version at activation: runtime version, Output line, Explorer description, status bar', async () => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    disposeSubscriptions(context);

    const { getRuntimeVersion } = await import('../../src/about/runtimeVersion');
    expect(getRuntimeVersion()).toBe('1.1.0');

    const channel = vi.mocked(vscode.window.createOutputChannel).mock.results[0]?.value as { appendLine: ReturnType<typeof vi.fn> };
    const lines = channel.appendLine.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes('FileMaker Data API Tools v1.1.0 (unknown) on VS Code 1.96.0'))).toBe(true);

    const treeCall = vi.mocked(vscode.window.createTreeView).mock.calls.findIndex(([id]) => id === 'filemakerExplorer');
    const tree = vi.mocked(vscode.window.createTreeView).mock.results[treeCall]?.value as { description?: string };
    expect(tree.description).toBe('v1.1.0');

    const tooltips = vi.mocked(vscode.window.createStatusBarItem).mock.results.map((r) => String((r.value as { tooltip?: string }).tooltip));
    expect(tooltips.some((tooltip) => tooltip.includes('FileMaker Data API Tools v1.1.0'))).toBe(true);
  });

  it('only asks the AI server controller to autostart (it starts nothing by itself), once', async () => {
    const { AiMcpController } = await import('../../src/ai/mcp/aiMcpController');
    const autostart = vi.spyOn(AiMcpController.prototype, 'autostart').mockResolvedValue(undefined);
    const start = vi.spyOn(AiMcpController.prototype, 'start').mockResolvedValue(undefined);
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    disposeSubscriptions(context);

    expect(autostart).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    autostart.mockRestore();
    start.mockRestore();
  });

  it('stops the AI server when the external-server permission setting changes, and ignores other settings', async () => {
    const { AiMcpController } = await import('../../src/ai/mcp/aiMcpController');
    const handle = vi.spyOn(AiMcpController.prototype, 'handleSettingChange').mockResolvedValue(undefined);
    vi.spyOn(AiMcpController.prototype, 'autostart').mockResolvedValue(undefined);
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);

    const listeners = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.map(([listener]) => listener);
    for (const listener of listeners) {
      listener({ affectsConfiguration: (section: string) => section === 'filemaker.offline' } as never);
    }
    expect(handle).not.toHaveBeenCalled();
    for (const listener of listeners) {
      listener({ affectsConfiguration: (section: string) => section === 'filemaker.ai.externalServer' } as never);
    }
    expect(handle).toHaveBeenCalledTimes(1);
    disposeSubscriptions(context);
    vi.restoreAllMocks();
  });

  it('loads and caches the FM client module on the first Connect command', async () => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);

    const connect = registeredCommand('filemakerDataApiTools.connect');
    await connect({ profileId: 'p1' });
    await connect({ profileId: 'p1' });
    disposeSubscriptions(context);

    expect(lazyModules.backoffModuleLoaded).toHaveBeenCalledTimes(1);
    expect(lazyModules.fmClientModuleLoaded).toHaveBeenCalledTimes(1);
    expect(lazyModules.fmClientConstructed).toHaveBeenCalledTimes(1);
    expect(lazyModules.retryWithBackoff).toHaveBeenCalledTimes(2);
    expect(lazyModules.createSession).toHaveBeenCalledTimes(2);
    expect(lazyModules.batchServiceModuleLoaded).not.toHaveBeenCalled();
    expect(lazyModules.circuitBreakerModuleLoaded).not.toHaveBeenCalled();
  });

  it('re-reads the Command Palette context keys when a profile is saved or removed and when the FM Web project is created', async () => {
    const { ProfileStore } = await import('../../src/services/profileStore');
    const { FmWebProjectService } = await import('../../src/services/fmWebProjectService');
    const profileListeners: Array<() => void> = [];
    const projectListeners: Array<() => void> = [];
    vi.spyOn(ProfileStore.prototype, 'onDidChange').mockImplementation((listener: () => void) => {
      profileListeners.push(listener);
      return { dispose: () => undefined };
    });
    vi.spyOn(FmWebProjectService.prototype, 'onDidChangeProject').mockImplementation((listener: () => void) => {
      projectListeners.push(listener);
      return { dispose: () => undefined };
    });
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    const keyCalls = (key: string) =>
      vi.mocked(vscode.commands.executeCommand).mock.calls.filter(([command, name]) => command === 'setContext' && name === key).length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(profileListeners).toHaveLength(1);
    expect(projectListeners).toHaveLength(1);
    const profileKeyBefore = keyCalls('filemaker.hasProfiles');
    profileListeners[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(keyCalls('filemaker.hasProfiles')).toBe(profileKeyBefore + 1);

    const projectKeyBefore = keyCalls('filemaker.fmWebProjectInitialized');
    projectListeners[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(keyCalls('filemaker.fmWebProjectInitialized')).toBe(projectKeyBefore + 1);

    // A project.json created, changed or deleted outside the extension is noticed as well.
    const watcherCalls = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.map(([pattern]) => String(pattern));
    expect(watcherCalls).toContain('**/.fmweb/project.json');
    disposeSubscriptions(context);
    vi.restoreAllMocks();
  });

  it('deactivate closes the sockets of every cached TLS agent (once the TLS module has been loaded), and is harmless before', async () => {
    const { activate, deactivate } = await import('../../src/extension');
    expect(() => deactivate()).not.toThrow(); // nothing loaded yet

    const context = createActivationContext();
    await activate(context);
    await registeredCommand('filemakerDataApiTools.connect')({ profileId: 'p1' }); // loads the TLS module
    const { createHttpsAgentForProfile } = await import('../../src/services/tlsAgent');
    const agent = createHttpsAgentForProfile({ pinnedCertSha256: 'ef'.repeat(32) });
    const destroy = vi.spyOn(agent, 'destroy');

    deactivate();
    disposeSubscriptions(context);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(() => deactivate()).not.toThrow();
  });
});

function installActivationVsCodeMocks(): void {
  const disposable = () => ({ dispose: vi.fn() });
  const createStatusBarItem = (): vscode.StatusBarItem => ({
    id: 'filemaker-test',
    alignment: vscode.StatusBarAlignment.Left,
    priority: undefined,
    name: undefined,
    text: '',
    tooltip: undefined,
    command: undefined,
    color: undefined,
    backgroundColor: undefined,
    accessibilityInformation: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
  });
  const configuration = {
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
    inspect: vi.fn(() => undefined),
    update: vi.fn()
  };

  const vscodeMock = vscode as unknown as {
    Disposable: new (callback: () => void) => vscode.Disposable;
    StatusBarAlignment: { Left: number; Right: number };
    ThemeColor: new (id: string) => unknown;
    window: typeof vscode.window & {
      createStatusBarItem: ReturnType<typeof vi.fn>;
      registerTreeDataProvider: ReturnType<typeof vi.fn>;
    };
    workspace: typeof vscode.workspace & {
      onDidGrantWorkspaceTrust: ReturnType<typeof vi.fn>;
      onDidChangeConfiguration: ReturnType<typeof vi.fn>;
    };
  };

  vscodeMock.Disposable = class {
    public constructor(private readonly callback: () => void) {}
    public dispose(): void {
      this.callback();
    }
  };
  vscodeMock.StatusBarAlignment = { Left: 1, Right: 2 };
  vscodeMock.ThemeColor = class {
    public constructor(public readonly id: string) {}
  };
  vscodeMock.window.createStatusBarItem = vi.fn(createStatusBarItem);
  vscodeMock.window.registerTreeDataProvider = vi.fn(disposable);
  vscodeMock.workspace.onDidGrantWorkspaceTrust = vi.fn(disposable);
  vscodeMock.workspace.onDidChangeConfiguration = vi.fn(disposable);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration as never);
  vi.mocked(vscode.commands.registerCommand).mockImplementation(() => disposable());
}

function createActivationContext(): vscode.ExtensionContext {
  const profile = {
    id: 'p1',
    name: 'Development',
    serverUrl: 'https://fm.example.test',
    database: 'Contacts',
    authMode: 'direct',
    username: 'admin'
  };
  const globalState = createMemento((key, defaultValue) => {
    if (key === 'filemakerDataApiTools.profiles') {
      return [profile];
    }
    return defaultValue;
  });

  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/test/extension'),
    globalState,
    workspaceState: createMemento(),
    secrets: {
      get: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      onDidChange: vi.fn()
    },
    extension: {
      id: 'SureForgeTech.filemaker-data-api-tools',
      packageJSON: { version: '1.1.0' }
    },
    extensionMode: 1,
    asAbsolutePath: (path: string) => `/test/extension/${path}`
  } as unknown as vscode.ExtensionContext;
}

function createMemento(
  getValue: (key: string, defaultValue?: unknown) => unknown = (_key, defaultValue) => defaultValue
): vscode.Memento {
  return {
    get: vi.fn(getValue),
    update: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn(() => []),
    setKeysForSync: vi.fn()
  } as unknown as vscode.Memento;
}

function registeredCommand(commandId: string): (arg?: unknown) => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registeredId]) => registeredId === commandId);
  expect(call).toBeDefined();
  return call?.[1] as (arg?: unknown) => Promise<void>;
}

function disposeSubscriptions(context: vscode.ExtensionContext): void {
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
}
