import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';

/**
 * Behavioral guard for the post-save onboarding flow: after a profile is saved
 * the wizard must offer a native "Connect Now" toast and, when the user accepts,
 * dispatch FileMaker: Connect with the freshly-saved profile id. This is the
 * step that closes the gap between "saved" and "connected" for first-run users.
 */

interface CapturedPanel {
  fireMessage: (message: unknown) => Promise<void>;
  posted: unknown[];
  logger: { warn: ReturnType<typeof vi.fn> };
}

function setupPanel(editingProfile?: Record<string, unknown>): CapturedPanel {
  const posted: unknown[] = [];
  let messageHandler: ((message: unknown) => unknown) | undefined;

  const panel = {
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn((message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      }
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  };

  // The panel tracks a single live instance in a static field; reset it so each
  // test gets a fresh panel (and a freshly registered message handler) instead
  // of the reuse/reveal branch in createOrShow.
  (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel =
    undefined;

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    panel as unknown as vscode.WebviewPanel
  );

  const context = {
    extensionUri: { fsPath: '/ext' },
    extension: { id: 'abd.fm' }
  } as unknown as vscode.ExtensionContext;

  const profileStore = {
    upsertProfile: vi.fn(async () => undefined)
  };
  const secretStore = {
    setPassword: vi.fn(async () => undefined),
    deleteProxyApiKey: vi.fn(async () => undefined),
    deletePassword: vi.fn(async () => undefined),
    setProxyApiKey: vi.fn(async () => undefined)
  };
  const fmClient = {};
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

  ConnectionWizardPanel.createOrShow(
    context,
    profileStore as never,
    secretStore as never,
    fmClient as never,
    logger as never,
    editingProfile as never
  );

  return {
    fireMessage: async (message: unknown) => {
      await messageHandler?.(message);
    },
    posted,
    logger
  };
}

const validSavePayload = {
  type: 'save',
  payload: {
    name: 'Production',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'MyDatabase',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest',
    username: 'api_user',
    password: 'secret'
  }
};

describe('Connection wizard post-save connect offer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockRejectedValue({ code: 'FileNotFound' });
  });

  it('offers Connect Now after a successful save', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);

    const panel = setupPanel();
    await panel.fireMessage(validSavePayload);
    await new Promise((resolve) => setImmediate(resolve));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const [prompt, action] = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    expect(prompt).toContain('Connect now');
    expect(action).toBe('Connect Now');
  });

  it('dispatches FileMaker: Connect with the saved profile id when accepted', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Connect Now' as never
    );

    const panel = setupPanel();
    await panel.fireMessage(validSavePayload);
    // Let the fire-and-forget offerConnect promise settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'filemakerDataApiTools.connect',
      expect.objectContaining({ profileId: expect.any(String) })
    );
  });

  it('does not connect when the user dismisses the toast', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);

    const panel = setupPanel();
    await panel.fireMessage(validSavePayload);
    await new Promise((resolve) => setImmediate(resolve));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'filemakerDataApiTools.connect',
      expect.anything()
    );
  });
});

describe('Connection wizard profile templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads a valid workspace template into the add-profile wizard', async () => {
    const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          name: 'Team Dev',
          authMode: 'direct',
          serverUrl: 'https://fm-dev.example.com',
          database: 'TeamApp',
          apiBasePath: '/fmi/data',
          apiVersionPath: 'vLatest',
          username: 'developer',
          locked: true
        })
      )
    );

    const panel = setupPanel();
    await panel.fireMessage({ type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    const loadTemplate = panel.posted.find(
      (message) => (message as { type?: string }).type === 'loadTemplate'
    ) as { payload?: Record<string, unknown> } | undefined;
    expect(loadTemplate?.payload).toMatchObject({
      template: {
        serverUrl: 'https://fm-dev.example.com',
        database: 'TeamApp',
        username: 'developer',
        locked: true
      },
      lockedFields: ['serverUrl', 'database', 'apiBasePath', 'apiVersionPath']
    });
  });

  it('loads unlocked templates without locking fields', async () => {
    const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          name: 'Team Dev',
          authMode: 'direct',
          serverUrl: 'https://fm-dev.example.com',
          database: 'TeamApp',
          locked: false
        })
      )
    );

    const panel = setupPanel();
    await panel.fireMessage({ type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    const loadTemplate = panel.posted.find(
      (message) => (message as { type?: string }).type === 'loadTemplate'
    ) as { payload?: Record<string, unknown> } | undefined;
    expect(loadTemplate?.payload).toMatchObject({
      template: {
        serverUrl: 'https://fm-dev.example.com',
        database: 'TeamApp',
        locked: false
      },
      lockedFields: []
    });
  });

  it('rejects credential-bearing templates without posting secret values', async () => {
    const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          serverUrl: 'https://fm-dev.example.com',
          database: 'TeamApp',
          password: 'super-secret'
        })
      )
    );

    const panel = setupPanel();
    await panel.fireMessage({ type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    const warning = panel.posted.find(
      (message) => (message as { type?: string }).type === 'templateWarning'
    ) as { message?: string } | undefined;
    expect(warning?.message).toContain('credential fields');
    expect(JSON.stringify(panel.posted)).not.toContain('super-secret');
    expect(panel.logger.warn).toHaveBeenCalledWith(
      'Profile template ignored.',
      expect.objectContaining({
        message: expect.not.stringContaining('super-secret')
      })
    );
  });

  it('does not apply workspace templates while editing an existing profile', async () => {
    const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          serverUrl: 'https://template.example.com',
          database: 'TemplateDB'
        })
      )
    );

    const panel = setupPanel({
      id: 'existing',
      name: 'Existing',
      authMode: 'direct',
      serverUrl: 'https://saved.example.com',
      database: 'SavedDB',
      username: 'saved'
    });
    await panel.fireMessage({ type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(readFile).not.toHaveBeenCalled();
    expect(panel.posted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'loadProfile',
          payload: expect.objectContaining({
            serverUrl: 'https://saved.example.com',
            database: 'SavedDB'
          })
        })
      ])
    );
    expect(panel.posted).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'loadTemplate' })])
    );
  });
});
