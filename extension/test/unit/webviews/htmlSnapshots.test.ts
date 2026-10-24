import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import { buildWebviewCsp, createNonce } from '../../../src/webviews/common/csp';
import { SchemaDiffPanel } from '../../../src/webviews/schemaDiff/index';
import type { SchemaDiffResult } from '../../../src/types/fm';

function setupWebviewPanelMock() {
  let capturedHtml = '';
  const webview = {
    onDidReceiveMessage: vi.fn(),
    postMessage: vi.fn().mockResolvedValue(true),
    asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
      toString: () => `https://cdn${uri.fsPath}`
    })),
    cspSource: 'https://cdn.test'
  };

  Object.defineProperty(webview, 'html', {
    get: () => capturedHtml,
    set: (v: string) => { capturedHtml = v; },
    configurable: true
  });

  const panel = {
    webview,
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    dispose: vi.fn(),
    onDidChangeViewState: vi.fn()
  };

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    panel as unknown as vscode.WebviewPanel
  );

  return { getHtml: () => capturedHtml };
}

describe('CSP utilities', () => {
  it('createNonce returns a 32-character alphanumeric string', () => {
    const nonce = createNonce();
    expect(nonce).toHaveLength(32);
    expect(nonce).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it('consecutive nonces are unique', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
  });

  it('buildWebviewCsp includes nonce and required directives', () => {
    const nonce = 'testNonce12345678901234567890ab';
    const mockWebview = { cspSource: 'https://cdn.test' } as unknown as vscode.Webview;
    const csp = buildWebviewCsp(mockWebview, { nonce });

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain('script-src');
    expect(csp).toContain('style-src');
    expect(csp).toContain('img-src');
    expect(csp).toContain('connect-src');
  });

  it('buildWebviewCsp includes inline style nonce when requested', () => {
    const nonce = 'testNonce12345678901234567890ab';
    const mockWebview = { cspSource: 'https://cdn.test' } as unknown as vscode.Webview;
    const csp = buildWebviewCsp(mockWebview, { nonce, allowInlineStyleWithNonce: true });

    // The style-src should have the nonce
    const styleSrcMatch = csp.match(/style-src\s+([^;]+)/);
    expect(styleSrcMatch).toBeTruthy();
    expect(styleSrcMatch![1]).toContain(`nonce-${nonce}`);
  });
});

describe('SchemaDiffPanel HTML output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the static currentPanel reference
    (SchemaDiffPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
  });

  const sampleDiff: SchemaDiffResult = {
    profileId: 'p1',
    layout: 'Contacts',
    comparedAt: '2026-01-01T00:00:00Z',
    added: [],
    removed: [],
    changed: [],
    summary: { added: 0, removed: 0, changed: 0 },
    hasChanges: false
  };

  it('sets HTML on the webview panel', () => {
    const { getHtml } = setupWebviewPanelMock();
    const context = {
      extensionUri: { fsPath: '/ext' },
      subscriptions: []
    } as unknown as vscode.ExtensionContext;

    SchemaDiffPanel.createOrShow(context, sampleDiff);
    const html = getHtml();

    expect(html.length).toBeGreaterThan(0);
  });

  it('includes CSP meta tag with nonce', () => {
    const { getHtml } = setupWebviewPanelMock();
    const context = {
      extensionUri: { fsPath: '/ext' },
      subscriptions: []
    } as unknown as vscode.ExtensionContext;

    SchemaDiffPanel.createOrShow(context, sampleDiff);
    const html = getHtml();

    expect(html).toContain('Content-Security-Policy');
    expect(html).toMatch(/nonce="[a-zA-Z0-9]+"/);
  });

  it('does not contain inline event handlers', () => {
    const { getHtml } = setupWebviewPanelMock();
    const context = {
      extensionUri: { fsPath: '/ext' },
      subscriptions: []
    } as unknown as vscode.ExtensionContext;

    SchemaDiffPanel.createOrShow(context, sampleDiff);
    const html = getHtml();

    expect(html).not.toMatch(/\sonclick=/i);
    expect(html).not.toMatch(/\sonload=/i);
    expect(html).not.toMatch(/\sonerror=/i);
  });

  it('includes script tag with nonce attribute', () => {
    const { getHtml } = setupWebviewPanelMock();
    const context = {
      extensionUri: { fsPath: '/ext' },
      subscriptions: []
    } as unknown as vscode.ExtensionContext;

    SchemaDiffPanel.createOrShow(context, sampleDiff);
    const html = getHtml();

    expect(html).toMatch(/<script\s+nonce="[a-zA-Z0-9]+"/);
  });
});
