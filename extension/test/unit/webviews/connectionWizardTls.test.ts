import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { SecretStore } from '../../../src/services/secretStore';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';
import { InMemorySecretStorage } from '../mocks';

const saved = {
  id: 'p1',
  name: 'Production',
  authMode: 'direct' as const,
  serverUrl: 'https://fm.example.com',
  database: 'Sales',
  apiBasePath: '/fmi/data',
  apiVersionPath: 'vLatest',
  username: 'alice'
};

const form = {
  name: 'Production',
  authMode: 'direct',
  serverUrl: 'https://fm.example.com',
  database: 'Sales',
  apiBasePath: '/fmi/data',
  apiVersionPath: 'vLatest',
  username: 'alice',
  password: 'pw'
};

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBkTCB\n-----END CERTIFICATE-----\n';
const CONFIRM = 'Allow insecure connection';

async function setup(editing?: Record<string, unknown>) {
  const posted: Array<{ type?: string; message?: string }> = [];
  let handler: ((message: unknown) => unknown) | undefined;
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn((message: never) => {
        posted.push(message);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: (callback: (message: unknown) => unknown) => {
        handler = callback;
        return { dispose: vi.fn() };
      }
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never);
  (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;

  const upsertProfile = vi.fn(async () => undefined);
  const createSession = vi.fn(async () => 'token');
  ConnectionWizardPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, extension: { id: 'x.y' } } as never,
    { upsertProfile, listProfiles: vi.fn(async () => []) } as never,
    new SecretStore(new InMemorySecretStorage() as never),
    { createSession, deleteSession: vi.fn(async () => undefined) } as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    editing as never
  );
  return {
    fire: async (message: unknown) => {
      const before = posted.length;
      await handler?.(message);
      // The handler reads files, so wait for its answer rather than one tick.
      for (let i = 0; i < 100 && !posted.slice(before).some((m) => /^(save|test)(Success|Error)$/.test(m.type ?? '')); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    posted,
    upsertProfile,
    createSession,
    saved: () => (upsertProfile.mock.calls[0] as unknown as [Record<string, unknown>] | undefined)?.[0]
  };
}

const modalCalls = () =>
  vi.mocked(vscode.window.showWarningMessage).mock.calls.filter(([, options]) => (options as { modal?: boolean })?.modal);
const lastError = (posted: Array<{ type?: string; message?: string }>) =>
  [...posted].reverse().find((m) => m.type === 'saveError')?.message;

describe('Connection wizard TLS options', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(path.join(tmpdir(), 'wizard-ca-'));
    (vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'FileNotFound' });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does not save the insecure option when the user declines the confirmation', async () => {
    const h = await setup();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    await h.fire({ type: 'save', payload: { ...form, allowSelfSigned: true } });

    expect(modalCalls()).toHaveLength(1);
    expect(String(modalCalls()[0]?.[0])).toContain('https://fm.example.com');
    expect(lastError(h.posted)).toMatch(/did not confirm accepting self-signed/);
    expect(h.upsertProfile).not.toHaveBeenCalled();
  });

  it('saves allowSelfSigned only after the confirmation, and asks once per address in a panel', async () => {
    const h = await setup();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(CONFIRM as never);

    await h.fire({ type: 'save', payload: { ...form, allowSelfSigned: true } });
    expect(h.saved()).toMatchObject({ allowSelfSigned: true });

    await h.fire({ type: 'save', payload: { ...form, allowSelfSigned: true } });
    expect(modalCalls()).toHaveLength(1);
  });

  it('does not ask again when the saved profile already allowed it for the same address, but does for a new one', async () => {
    const same = await setup({ ...saved, allowSelfSigned: true });
    await same.fire({ type: 'save', payload: { ...form, allowSelfSigned: true } });
    expect(modalCalls()).toHaveLength(0);
    expect(same.saved()).toMatchObject({ allowSelfSigned: true });

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    const moved = await setup({ ...saved, allowSelfSigned: true });
    await moved.fire({
      type: 'save',
      payload: { ...form, serverUrl: 'https://other.example.net', allowSelfSigned: true }
    });
    expect(modalCalls().length).toBeGreaterThan(0);
    expect(moved.upsertProfile).not.toHaveBeenCalled();
  });

  it('leaves the option off when the box is unchecked', async () => {
    const off = await setup();
    await off.fire({ type: 'save', payload: { ...form } });
    expect(off.saved()?.allowSelfSigned).toBeUndefined();
    expect(modalCalls()).toHaveLength(0);
  });

  it('tells the user the option does not apply to an http address instead of silently dropping it', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Continue anyway' as never);
    const http = await setup();
    await http.fire({ type: 'save', payload: { ...form, serverUrl: 'http://localhost:8080', allowSelfSigned: true } });
    expect(lastError(http.posted)).toMatch(/only applies to https/);
    expect(http.upsertProfile).not.toHaveBeenCalled();
  });

  it('rejects a form whose allowSelfSigned is not a boolean', async () => {
    const h = await setup();
    await h.fire({ type: 'save', payload: { ...form, allowSelfSigned: 'yes' } });
    expect(lastError(h.posted)).toMatch(/not valid/);
    expect(h.upsertProfile).not.toHaveBeenCalled();
  });

  it('saves a valid custom CA file path and refuses an invalid one', async () => {
    const ca = path.join(dir, 'ca.pem');
    await writeFile(ca, CERT);
    const good = await setup();
    await good.fire({ type: 'save', payload: { ...form, caBundlePath: `  ${ca} ` } });
    expect(good.saved()).toMatchObject({ caBundlePath: ca });

    const bad = await setup();
    await bad.fire({ type: 'save', payload: { ...form, caBundlePath: path.join(dir, 'missing.pem') } });
    expect(lastError(bad.posted)).toMatch(/could not be read/);
    expect(bad.upsertProfile).not.toHaveBeenCalled();

    const relative = await setup();
    await relative.fire({ type: 'save', payload: { ...form, caBundlePath: 'ca.pem' } });
    expect(lastError(relative.posted)).toMatch(/absolute path/);
  });

  it('Test Connection uses the same options and the same confirmation', async () => {
    const ca = path.join(dir, 'ca.pem');
    await writeFile(ca, CERT);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(CONFIRM as never);
    const h = await setup();

    await h.fire({ type: 'testConnection', payload: { ...form, allowSelfSigned: true, caBundlePath: ca } });

    expect(modalCalls()).toHaveLength(1);
    expect(h.createSession).toHaveBeenCalledWith(expect.objectContaining({ allowSelfSigned: true, caBundlePath: ca }));
  });

  it('keeps AI access when a profile is edited without moving it', async () => {
    const h = await setup({ ...saved, aiAccess: 'read' });
    await h.fire({ type: 'save', payload: { ...form } });
    expect(h.saved()).toMatchObject({ aiAccess: 'read' });
  });

  it.each([
    ['database', { database: 'Other' }],
    ['API base path', { apiBasePath: '/fmi/other' }],
    ['API version', { apiVersionPath: 'v1' }]
  ])('resets AI access to none when only the %s changes', async (_label, change) => {
    const h = await setup({ ...saved, aiAccess: 'write' });
    await h.fire({ type: 'save', payload: { ...form, ...change } });
    expect(h.saved()).toBeDefined();
    expect(h.saved()?.aiAccess).toBeUndefined();
  });

  it('exposes the options in the form: a labelled CA field, a warned checkbox, and no template hook', async () => {
    await setup();
    const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } })
      .webview.html;
    expect(html).toContain('id="caBundlePath"');
    expect(html).toContain('Allow self-signed certificate (insecure)');
    expect(html).toMatch(/anyone on the network could impersonate the server/);
  });
});
