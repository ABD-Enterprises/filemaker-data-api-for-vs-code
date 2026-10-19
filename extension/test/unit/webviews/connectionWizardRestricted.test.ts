import { readFileSync } from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { SecretStore } from '../../../src/services/secretStore';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { InMemorySecretStorage } from '../mocks';

const uiSource = readFileSync(path.resolve(__dirname, '../../../src/webviews/connectionWizard/ui/index.js'), 'utf8');

function open(trusted: boolean) {
  (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = trusted;
  let onMessage: ((message: unknown) => void) | undefined;
  let onGrant: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  vi.mocked(vscode.workspace.onDidGrantWorkspaceTrust).mockImplementation(((cb: () => void) => ((onGrant = cb), { dispose: vi.fn() })) as never);
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u,
      postMessage: vi.fn(async (m: Record<string, unknown>) => (posted.push(m), true)),
      onDidReceiveMessage: (cb: (message: unknown) => void) => ((onMessage = cb), { dispose: vi.fn() })
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never);
  (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  ConnectionWizardPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, extension: { id: 'x.y' } } as never,
    { upsertProfile: vi.fn(), listProfiles: vi.fn(async () => []) } as never,
    new SecretStore(new InMemorySecretStorage() as never),
    {} as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  );
  const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
  return { html, posted, send: (m: unknown) => onMessage?.(m), grant: () => onGrant?.() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('connection wizard in Restricted Mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tells the page whether the workspace is restricted when it starts', async () => {
    for (const trusted of [false, true]) {
      const { posted, send } = open(trusted);
      send({ type: 'ready' });
      await flush();
      expect(posted.find((m) => m.type === 'init')?.restricted, String(trusted)).toBe(!trusted);
    }
  });

  it('the Manage Workspace Trust button asks VS Code for the trust editor', async () => {
    const { send } = open(false);
    send({ type: 'manageWorkspaceTrust' });
    await flush();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.trust.manage');
  });

  it('trusting the workspace while the wizard is open sends a fresh init (so the notice goes away)', async () => {
    const { posted, grant } = open(false);
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    grant();
    await flush();
    expect(posted.filter((m) => m.type === 'init').at(-1)?.restricted).toBe(false);
  });

  describe.skipIf(!JSDOM)('the page', () => {
    const notice = (restricted: boolean | undefined) => {
      const { html } = open(!restricted);
      const page = loadPage(html, uiSource);
      page.send({ type: 'init', testPolicy: 'warn', restricted });
      return page;
    };

    it('shows the notice at the top, says what is limited, and offers Manage Workspace Trust', () => {
      const page = notice(true);
      const element = page.document.getElementById('restrictedNotice');
      expect(element?.classList.contains('hidden')).toBe(false);
      const text = element?.textContent ?? '';
      expect(text).toMatch(/This workspace is in Restricted Mode/);
      expect(text).toMatch(/profile template.*is ignored/);
      expect(text).toMatch(/workspace settings.*ignored until you trust the workspace/);
      expect(page.document.getElementById('manageTrustBtn')?.textContent).toBe('Manage Workspace Trust');
      // It comes before the form's own heading.
      const body = page.document.body.textContent ?? '';
      expect(body.indexOf('This workspace is in Restricted Mode')).toBeLessThan(body.indexOf('Connection Profile'));
      page.document.getElementById('manageTrustBtn')?.click();
      expect(page.posted).toContainEqual({ type: 'manageWorkspaceTrust' });
    });

    it('is hidden in a trusted workspace, and hidden again when trust arrives', () => {
      expect(notice(false).document.getElementById('restrictedNotice')?.classList.contains('hidden')).toBe(true);
      const page = notice(true);
      page.send({ type: 'init', testPolicy: 'warn', restricted: false });
      expect(page.document.getElementById('restrictedNotice')?.classList.contains('hidden')).toBe(true);
    });
  });
});
