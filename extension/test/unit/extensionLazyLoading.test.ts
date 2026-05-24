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
});

function installActivationVsCodeMocks(): void {
  const disposable = () => ({ dispose: vi.fn() });
  const createStatusBarItem = () => ({
    text: '',
    tooltip: undefined as string | undefined,
    command: undefined as string | undefined,
    backgroundColor: undefined as unknown,
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
      id: 'deffenda.filemaker-data-api-tools',
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
