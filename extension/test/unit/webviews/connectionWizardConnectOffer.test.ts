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
}

function setupPanel(): CapturedPanel {
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
    logger as never
  );

  return {
    fireMessage: async (message: unknown) => {
      await messageHandler?.(message);
    },
    posted
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
