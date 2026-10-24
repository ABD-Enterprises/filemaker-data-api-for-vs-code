import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import type * as BatchCommands from '../../src/commands/batch';
import type * as FmBridgeServerModule from '../../src/services/fmBridgeServer';
import type * as FmWebProjectServiceModule from '../../src/services/fmWebProjectService';
import type * as SchemaServiceModule from '../../src/services/schemaService';

/**
 * The wiring of `activate()`: which services exist, which one each of them is handed, and when the
 * heavy ones are loaded. `activate()` runs headlessly here (the VS Code API is mocked), so the
 * wiring is read from the running extension, not from the source text.
 *
 * The order of the service constructions matters: a service is built from the one it depends on,
 * so building them in another order is a wiring bug, not a style choice. The test therefore pins
 * the order and the identity of the arguments: moving a construction (or handing a service a
 * different dependency) makes this file fail.
 */

type ServiceCall = { instance: unknown; args: unknown[] };

const wiring = vi.hoisted(() => ({
  fmClientModuleLoaded: vi.fn(),
  fmClientConstructed: vi.fn(),
  listLayouts: vi.fn(async () => ['Contacts']),
  batchServiceModuleLoaded: vi.fn(),
  batchServiceConstructed: vi.fn(),
  constructionOrder: [] as string[],
  schemaService: undefined as ServiceCall | undefined,
  fmWebProjectService: undefined as ServiceCall | undefined,
  fmBridgeServer: undefined as ServiceCall | undefined,
  batchServiceOption: undefined as unknown,
  // The real class behind the mock, so its prototype can be stubbed without reaching into the
  // subclass the mock installs.
  actualFmWebProjectService: undefined as
    | (typeof FmWebProjectServiceModule)['FmWebProjectService']
    | undefined
}));

vi.mock('../../src/services/fmClient', () => {
  wiring.fmClientModuleLoaded();

  return {
    FMClient: class {
      public constructor(...args: unknown[]) {
        wiring.fmClientConstructed(...args);
      }

      public listLayouts = wiring.listLayouts;
      public createSession = async (): Promise<string> => 'token';
      public deleteSession = async (): Promise<void> => undefined;
      public invalidateProfileCache(): void {}
      public forgetProfile(): void {}
      public clearAuthPause(): void {}
      public getHealth(): undefined {
        return undefined;
      }
      public isSignInPaused(): boolean {
        return false;
      }
      public shouldRefreshSession(): boolean {
        return false;
      }
      public onProfileInvalidated(): () => void {
        return () => undefined;
      }
      public onHealthChange(): () => void {
        return () => undefined;
      }
    }
  };
});

vi.mock('../../src/services/batchService', () => {
  wiring.batchServiceModuleLoaded();

  return {
    BatchService: class {
      public constructor(...args: unknown[]) {
        wiring.batchServiceConstructed(...args);
      }

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

vi.mock('../../src/services/schemaService', async (importOriginal) => {
  const actual = await importOriginal<typeof SchemaServiceModule>();

  return {
    ...actual,
    SchemaService: class extends actual.SchemaService {
      public constructor(...args: ConstructorParameters<typeof actual.SchemaService>) {
        super(...args);
        wiring.constructionOrder.push('SchemaService');
        wiring.schemaService = { instance: this, args };
      }
    }
  };
});

vi.mock('../../src/services/fmWebProjectService', async (importOriginal) => {
  const actual = await importOriginal<typeof FmWebProjectServiceModule>();
  wiring.actualFmWebProjectService = actual.FmWebProjectService;

  return {
    ...actual,
    FmWebProjectService: class extends actual.FmWebProjectService {
      public constructor(...args: ConstructorParameters<typeof actual.FmWebProjectService>) {
        super(...args);
        wiring.constructionOrder.push('FmWebProjectService');
        wiring.fmWebProjectService = { instance: this, args };
      }
    }
  };
});

vi.mock('../../src/services/fmBridgeServer', async (importOriginal) => {
  const actual = await importOriginal<typeof FmBridgeServerModule>();

  return {
    ...actual,
    FmBridgeServer: class extends actual.FmBridgeServer {
      public constructor(...args: ConstructorParameters<typeof actual.FmBridgeServer>) {
        super(...args);
        wiring.constructionOrder.push('FmBridgeServer');
        wiring.fmBridgeServer = { instance: this, args };
      }
    }
  };
});

vi.mock('../../src/commands/batch', async (importOriginal) => {
  const actual = await importOriginal<typeof BatchCommands>();

  return {
    ...actual,
    registerBatchCommands: (options: Parameters<typeof actual.registerBatchCommands>[0]) => {
      wiring.batchServiceOption = options.batchService;
      return actual.registerBatchCommands(options);
    }
  };
});

describe('activation wiring', () => {
  let context: vscode.ExtensionContext;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    wiring.constructionOrder.length = 0;
    wiring.schemaService = undefined;
    wiring.fmWebProjectService = undefined;
    wiring.fmBridgeServer = undefined;
    wiring.batchServiceOption = undefined;
    installActivationVsCodeMocks();
    // Keep activation away from the file system of the machine it runs on.
    await import('../../src/services/fmWebProjectService');
    const { SchemaSnapshotStore } = await import('../../src/services/schemaSnapshotStore');
    vi.spyOn(wiring.actualFmWebProjectService!.prototype, 'readProjectConfig').mockResolvedValue(undefined);
    vi.spyOn(SchemaSnapshotStore.prototype, 'listSnapshots').mockResolvedValue([]);
    context = createActivationContext();
  });

  afterEach(() => {
    disposeSubscriptions(context);
    vi.restoreAllMocks();
  });

  it('registers a command for every command the extension contributes', async () => {
    await activateExtension(context);

    const { contributes } = (await import('../../package.json')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    const registered = new Set(registeredCommandIds());

    expect(contributes.commands.map(({ command }) => command).filter((id) => !registered.has(id))).toEqual([]);
  });

  it('builds the services the commands need, and builds each of them once', async () => {
    await activateExtension(context);

    expect(wiring.schemaService?.instance).toBeDefined();
    expect(wiring.fmWebProjectService?.instance).toBeDefined();
    expect(wiring.fmBridgeServer?.instance).toBeDefined();
    expect(wiring.constructionOrder.filter((name) => name === 'SchemaService')).toHaveLength(1);
    expect(wiring.constructionOrder.filter((name) => name === 'FmWebProjectService')).toHaveLength(1);
    expect(wiring.constructionOrder.filter((name) => name === 'FmBridgeServer')).toHaveLength(1);
  });

  it('builds a service after the one it depends on', async () => {
    await activateExtension(context);

    // A service is built from the one it depends on, so the dependency has to exist first.
    expect(wiring.constructionOrder).toEqual(['SchemaService', 'FmWebProjectService', 'FmBridgeServer']);
  });

  it('hands every service the dependency it was built for', async () => {
    await activateExtension(context);

    const schemaService = wiring.schemaService!;
    const fmWebProjectService = wiring.fmWebProjectService!;
    const fmBridgeServer = wiring.fmBridgeServer!;

    // The FM client is the same lazy client everywhere.
    expect(fmWebProjectService.args[1]).toBe(schemaService.args[0]);
    expect(fmBridgeServer.args[1]).toBe(schemaService.args[0]);
    // The FM Web project service reads the schema through the schema service, not through its own.
    expect(fmWebProjectService.args[2]).toBe(schemaService.instance);
    // The bridge server reads the project through the FM Web project service.
    expect(fmBridgeServer.args[2]).toBe(fmWebProjectService.instance);
  });

  it('resolves the FM client only when a service asks it for something', async () => {
    await activateExtension(context);

    expect(wiring.fmClientModuleLoaded).not.toHaveBeenCalled();

    const lazyClient = wiring.schemaService!.args[0] as {
      listLayouts: (profile: unknown) => Promise<string[]>;
    };
    await lazyClient.listLayouts({ id: 'p1' });

    expect(wiring.fmClientModuleLoaded).toHaveBeenCalledTimes(1);
    expect(wiring.fmClientConstructed).toHaveBeenCalledTimes(1);
    expect(wiring.listLayouts).toHaveBeenCalledWith({ id: 'p1' });

    await lazyClient.listLayouts({ id: 'p1' });

    // The second request uses the client that is already loaded.
    expect(wiring.fmClientConstructed).toHaveBeenCalledTimes(1);
  });

  it('resolves the batch service only when a batch command asks for it', async () => {
    await activateExtension(context);

    expect(wiring.batchServiceModuleLoaded).not.toHaveBeenCalled();

    const batchService = wiring.batchServiceOption as {
      getDefaultBatchUpdateOptions: () => Promise<{ dryRun: boolean; concurrency: number }>;
    };
    expect(await batchService.getDefaultBatchUpdateOptions()).toEqual({ dryRun: true, concurrency: 4 });

    expect(wiring.batchServiceModuleLoaded).toHaveBeenCalledTimes(1);
    expect(wiring.batchServiceConstructed).toHaveBeenCalledTimes(1);
  });

  it('keeps the disposable of every command in the extension context', async () => {
    await activateExtension(context);

    const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
    const results = vi.mocked(vscode.commands.registerCommand).mock.results;
    const subscriptions = new Set(context.subscriptions);
    const missing = calls
      .map(([id], index) => ({ id, disposable: results[index]?.value }))
      .filter(({ id }) => !id.startsWith('filemakerDataApiTools.plugin.'))
      .filter(({ disposable }) => !subscriptions.has(disposable as { dispose: () => void }))
      .map(({ id }) => id);

    expect(calls.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  const { activate } = await import('../../src/extension');
  await activate(context);
}

function registeredCommandIds(): string[] {
  return vi.mocked(vscode.commands.registerCommand).mock.calls.map(([id]) => id);
}

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

function disposeSubscriptions(context: vscode.ExtensionContext): void {
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
}
