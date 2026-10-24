import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { SecretStore } from '../../../src/services/secretStore';
import type { SchemaDiffResult } from '../../../src/types/fm';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';
import { SchemaDiffPanel } from '../../../src/webviews/schemaDiff';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { InMemorySecretStorage } from '../mocks';

/**
 * A request the host could not finish is reported to the page as {type: 'error', message}.
 * These tests put that message through the real page script and look at what the user sees:
 * the reason, in the place the panel keeps its status, and no skeleton left spinning.
 */

const wizardUi = readFileSync(path.resolve(__dirname, '../../../src/webviews/connectionWizard/ui/index.js'), 'utf8');
const schemaDiffUi = readFileSync(path.resolve(__dirname, '../../../src/webviews/schemaDiff/ui/index.js'), 'utf8');

const diff: SchemaDiffResult = {
  profileId: 'p1',
  layout: 'Contacts',
  comparedAt: '2026-01-01T00:00:00Z',
  added: [],
  removed: [],
  changed: [],
  summary: { added: 0, removed: 0, changed: 0 },
  hasChanges: false
};

function webviewPanelMock() {
  return {
    webview: {
      html: '',
      cspSource: 'x',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() }))
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never;
}

function wizardPage() {
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(webviewPanelMock());
  (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  ConnectionWizardPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, extension: { id: 'x.y' } } as never,
    { upsertProfile: vi.fn(), listProfiles: vi.fn(async () => []) } as never,
    new SecretStore(new InMemorySecretStorage() as never),
    {} as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  );
  const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
  return loadPage(html, wizardUi, 'https://wizard.invalid/');
}

function schemaDiffPage() {
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(webviewPanelMock());
  (SchemaDiffPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  SchemaDiffPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, subscriptions: [] } as never,
    diff,
    { error: vi.fn() }
  );
  const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
  return loadPage(html, 'window.requestAnimationFrame = (callback) => callback();\n' + schemaDiffUi, 'https://schemadiff.invalid/');
}

describe.skipIf(!JSDOM)('The connection wizard shows a failure the host reports', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the reason in the status line', () => {
    const page = wizardPage();

    page.send({ type: 'error', message: 'The profiles could not be read.' });

    const status = page.document.getElementById('status');
    expect(status?.textContent).toBe('The profiles could not be read.');
    expect(status?.classList.contains('error')).toBe(true);
  });

  it('shows a reason of its own when the host sends none', () => {
    const page = wizardPage();

    page.send({ type: 'error', message: '' });

    expect(page.document.getElementById('status')?.textContent).toBe('Something went wrong.');
  });
});

describe.skipIf(!JSDOM)('The schema diff shows a failure the host reports', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the reason above the diff and takes the skeleton away', () => {
    const page = schemaDiffPage();
    // The skeleton is on screen while the diff is on its way.
    expect(page.document.querySelectorAll('.loading-skeleton:not(.hidden)')).toHaveLength(1);

    page.send({ type: 'error', message: 'The schema snapshots could not be read.' });

    expect(page.document.getElementById('summary')?.textContent).toBe('The schema snapshots could not be read.');
    expect(page.document.querySelectorAll('.loading-skeleton:not(.hidden)')).toHaveLength(0);
    expect(page.document.querySelectorAll('.diff-section.loaded')).toHaveLength(2);
  });
});
