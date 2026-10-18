import nock from 'nock';
import { vi } from 'vitest';

vi.mock('vscode', () => {
  const outputChannel = {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn()
  };

  const createUri = (value: string) => ({ fsPath: value, toString: () => value });

  return {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: createUri('/tmp/workspace') }],
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue)
      })),
      onDidGrantWorkspaceTrust: vi.fn(() => ({ dispose: vi.fn() })),
      openTextDocument: vi.fn(),
      createFileSystemWatcher: vi.fn(() => ({
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn()
      })),
      fs: {
        writeFile: vi.fn(),
        readFile: vi.fn(),
        createDirectory: vi.fn()
      }
    },
    window: {
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn(),
      showTextDocument: vi.fn(),
      withProgress: vi.fn((_options, task) => task()),
      createOutputChannel: vi.fn(() => outputChannel),
      createStatusBarItem: vi.fn(() => ({
        text: '',
        tooltip: '',
        show: vi.fn(),
        dispose: vi.fn()
      })),
      createWebviewPanel: vi.fn(),
      createTreeView: vi.fn(() => ({
        onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
        reveal: vi.fn(),
        dispose: vi.fn()
      }))
    },
    commands: {
      executeCommand: vi.fn(),
      registerCommand: vi.fn(() => ({ dispose: vi.fn() }))
    },
    env: {
      clipboard: {
        writeText: vi.fn()
      },
      openExternal: vi.fn()
    },
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3
    },
    Uri: {
      parse: vi.fn((value: string) => createUri(value)),
      file: vi.fn((value: string) => createUri(value)),
      joinPath: vi.fn((_base: { fsPath: string }, ...segments: string[]) => createUri(segments.join('/')))
    },
    LanguageModelTextPart: class {
      constructor(public value: string) {}
    },
    LanguageModelToolResult: class {
      constructor(public content: unknown[]) {}
    },
    languages: {
      createDiagnosticCollection: vi.fn(() => ({
        set: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn()
      }))
    },
    ViewColumn: {
      One: 1
    },
    ProgressLocation: {
      Window: 10
    },
    StatusBarAlignment: {
      Left: 1,
      Right: 2
    },
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2
    },
    TreeItem: class {
      label: string;
      collapsibleState: number;
      description?: string;
      tooltip?: string;
      contextValue?: string;
      command?: unknown;
      iconPath?: unknown;
      constructor(label: string, collapsibleState?: number) {
        this.label = label;
        this.collapsibleState = collapsibleState ?? 0;
      }
    },
    ThemeColor: class {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    ThemeIcon: class {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    EventEmitter: class {
      private handlers: Array<(...args: unknown[]) => void> = [];
      event = (handler: (...args: unknown[]) => void) => {
        this.handlers.push(handler);
        return { dispose: vi.fn() };
      };
      fire = (data?: unknown) => {
        for (const handler of this.handlers) {
          handler(data);
        }
      };
      dispose = vi.fn();
    }
  };
});

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});
