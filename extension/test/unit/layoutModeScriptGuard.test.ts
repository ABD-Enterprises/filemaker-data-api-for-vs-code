import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LayoutModePanel } from '../../src/webviews/layoutMode';

/**
 * A layout file arrives with the repository, so a `runScript` binding is the repository asking
 * to run a script on the user's FileMaker server. It must pass the Script Runner's checks and
 * the user's explicit confirmation before anything runs.
 */

type Handler = (message: unknown) => void;

const profile = {
  id: 'p1',
  name: 'Production',
  authMode: 'direct',
  serverUrl: 'https://fm.example.com',
  database: 'Sales'
};

let disposePanel: (() => void) | undefined;

function openPanel(options: {
  projectProfileId?: string;
  userProfileId?: string;
  assertScriptRunAllowed?: () => Promise<boolean>;
  profileExists?: boolean;
}) {
  let handler: Handler | undefined;
  const posted: Array<{ type?: string; payload?: { ok?: boolean; message?: string; stub?: boolean } }> = [];

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message: never) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: (callback: Handler) => {
        handler = callback;
        return { dispose: vi.fn() };
      }
    },
    reveal: vi.fn(),
    onDidDispose: (callback: () => void) => {
      disposePanel = callback;
      return { dispose: vi.fn() };
    }
  } as never);

  const runScript = vi.fn(async () => ({ scriptResult: 'ok' }));
  const profileStore = {
    getProfile: vi.fn(async () => (options.profileExists === false ? undefined : profile)),
    getActiveProfileId: vi.fn(() => options.userProfileId)
  };
  const fmWebProjectService = {
    readProjectConfig: vi.fn(async () => ({ activeProfileId: options.projectProfileId })),
    ensureProjectInitialized: vi.fn(),
    loadOrCreateLayout: vi.fn(),
    loadMetadataCache: vi.fn(),
    getAvailableFields: vi.fn()
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  LayoutModePanel.createOrShow(
    { extensionUri: { fsPath: '/ext' } } as never,
    fmWebProjectService as never,
    profileStore as never,
    { runScript } as never,
    logger as never,
    { assertScriptRunAllowed: options.assertScriptRunAllowed }
  );

  const send = async (behavior: Record<string, unknown>): Promise<void> => {
    handler?.({
      type: 'executeBehavior',
      payload: {
        layoutId: 'layout-1',
        layoutName: 'Customers',
        fmLayoutName: 'Contacts',
        objectId: 'obj-1',
        objectName: 'Delete Everything',
        behavior
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const result = () => posted.filter((message) => message.type === 'behaviorResult').pop()?.payload;
  return { send, runScript, result };
}

const runBinding = { type: 'runScript', scriptName: 'Purge Records', parameter: 'all' };

function setConfig(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback)
  } as never);
}

describe('Layout Mode script runs', () => {
  beforeEach(() => {
    disposePanel?.();
    vi.clearAllMocks();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    setConfig({});
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run script' as never);
  });

  it('asks first, naming the script, parameter and connection, then runs it when confirmed', async () => {
    const panel = openPanel({ userProfileId: 'p1', projectProfileId: 'p1' });

    await panel.send(runBinding);

    const prompt = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0] as string;
    expect(prompt).toContain('Purge Records');
    expect(prompt).toContain('Parameter: all');
    expect(prompt).toContain('Production (https://fm.example.com)');
    expect(prompt).toContain('comes from the layout file in your workspace');
    expect(panel.runScript).toHaveBeenCalledTimes(1);
  });

  it('does not run the script when the user declines', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    const panel = openPanel({ userProfileId: 'p1' });

    await panel.send(runBinding);

    expect(panel.runScript).not.toHaveBeenCalled();
    expect(panel.result()).toMatchObject({ ok: false, message: 'Script run cancelled.' });
  });

  it('says so when the project file, not the user, chose the connection', async () => {
    const panel = openPanel({ userProfileId: 'p-mine', projectProfileId: 'p1' });

    await panel.send(runBinding);

    const prompt = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0] as string;
    expect(prompt).toContain('project file in this workspace chose this connection');
  });

  it('is blocked in an untrusted workspace without asking', async () => {
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
    const panel = openPanel({ userProfileId: 'p1' });

    await panel.send(runBinding);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(panel.runScript).not.toHaveBeenCalled();
    expect(panel.result()?.message).toMatch(/trusted workspace/);
  });

  it('is blocked when the script runner is switched off or offline mode is on', async () => {
    setConfig({ 'features.scriptRunner.enabled': false });
    const off = openPanel({ userProfileId: 'p1' });
    await off.send(runBinding);
    expect(off.runScript).not.toHaveBeenCalled();
    expect(off.result()?.message).toMatch(/disabled by the setting/);

    disposePanel?.();
    setConfig({ 'offline.mode': true });
    const offline = openPanel({ userProfileId: 'p1' });
    await offline.send(runBinding);
    expect(offline.runScript).not.toHaveBeenCalled();
    expect(offline.result()?.message).toMatch(/Offline mode/);
  });

  it('is blocked when enterprise policy does not allow running scripts', async () => {
    const panel = openPanel({ userProfileId: 'p1', assertScriptRunAllowed: async () => false });

    await panel.send(runBinding);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(panel.runScript).not.toHaveBeenCalled();
    expect(panel.result()?.message).toMatch(/enterprise policy/);
  });

  it('only previews, without asking, when there is no connection to run against', async () => {
    const panel = openPanel({ profileExists: false });

    await panel.send(runBinding);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(panel.runScript).not.toHaveBeenCalled();
    expect(panel.result()).toMatchObject({ ok: true, stub: true });
  });

  it('does not ask about behaviours that do not run scripts', async () => {
    const panel = openPanel({ userProfileId: 'p1' });

    await panel.send({ type: 'goToWebLayout', targetLayoutId: 'layout-2' });

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});
