import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';

import { createNonce, buildWebviewCsp, profileImageSources, serverOrigin } from '../../src/webviews/common/csp';

function mockWebview(cspSource = 'https://cdn.test'): vscode.Webview {
  return { cspSource } as unknown as vscode.Webview;
}

describe('createNonce', () => {
  it('returns a 32-character string', () => {
    expect(createNonce()).toHaveLength(32);
  });

  it('contains only alphanumeric characters', () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('produces unique values on each call', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => createNonce()));
    expect(nonces.size).toBe(20);
  });
});

describe('buildWebviewCsp', () => {
  it('includes default-src none', () => {
    const csp = buildWebviewCsp(mockWebview(), { nonce: 'abc' });
    expect(csp).toContain("default-src 'none'");
  });

  it('includes script-src with nonce', () => {
    const csp = buildWebviewCsp(mockWebview(), { nonce: 'myNonce123' });
    expect(csp).toContain("script-src 'nonce-myNonce123'");
  });

  it('includes style-src with webview csp source', () => {
    const csp = buildWebviewCsp(mockWebview('https://cdn.example'), { nonce: 'n' });
    expect(csp).toContain('style-src https://cdn.example');
  });

  it('includes style nonce when allowInlineStyleWithNonce is true', () => {
    const csp = buildWebviewCsp(mockWebview(), {
      nonce: 'styleNonce',
      allowInlineStyleWithNonce: true
    });
    expect(csp).toContain("'nonce-styleNonce'");
    // Should appear in style-src
    const stylePart = csp.split(';').find((d) => d.trim().startsWith('style-src'));
    expect(stylePart).toContain('nonce-styleNonce');
  });

  it('includes img-src with data: scheme', () => {
    const csp = buildWebviewCsp(mockWebview(), { nonce: 'n' });
    expect(csp).toContain('img-src');
    expect(csp).toContain('data:');
  });

  it('includes connect-src', () => {
    const csp = buildWebviewCsp(mockWebview(), { nonce: 'n' });
    expect(csp).toContain('connect-src');
  });

  it('includes custom connect sources', () => {
    const csp = buildWebviewCsp(mockWebview(), {
      nonce: 'n',
      connectSources: ['https://api.example.com']
    });
    expect(csp).toContain('https://api.example.com');
  });

  it('allows an image from the origin of a server, and from no other host', () => {
    const csp = buildWebviewCsp(mockWebview(), {
      nonce: 'n',
      imageSources: ['https://fm.example.com']
    });
    const imagePart = csp.split(';').find((part) => part.trim().startsWith('img-src'))!;
    const sources = imagePart.replace(/^\s*img-src\s*/, '').split(/\s+/);
    expect(sources).toContain('https://fm.example.com');
    // Every host on the internet stays out of the webview.
    expect(sources).not.toContain('https:');
  });
});

describe('server origins', () => {
  it('takes the scheme and host of a server URL, without its path', () => {
    expect(serverOrigin('https://fm.example.com/fmi/data/vLatest')).toBe('https://fm.example.com');
    expect(serverOrigin('http://fm.example.com:8080/fmi')).toBe('http://fm.example.com:8080');
  });

  it('has no origin for a URL that is not an http(s) server', () => {
    expect(serverOrigin('not a url')).toBeUndefined();
    expect(serverOrigin('file:///etc/passwd')).toBeUndefined();
    expect(serverOrigin(undefined)).toBeUndefined();
  });
});

describe('profileImageSources', () => {
  it('lists the origin of every stored profile, once each', () => {
    const store = {
      listProfilesSync: () => [
        { serverUrl: 'https://fm.example.com/fmi/data' },
        { serverUrl: 'http://other.example.com:8080' },
        { serverUrl: 'https://fm.example.com/other' },
        { serverUrl: 'not a url' }
      ]
    };
    expect(profileImageSources(store)).toEqual(['https://fm.example.com', 'http://other.example.com:8080']);
  });

  it('has no source when the profiles cannot be read', () => {
    expect(profileImageSources(undefined)).toEqual([]);
    expect(profileImageSources({})).toEqual([]);
    expect(profileImageSources({ listProfilesSync: () => undefined })).toEqual([]);
  });
});

describe('the panels that show a record', () => {
  /** Answers every call with a resolved undefined, so a panel constructor can run against it. */
  const loose = (): never =>
    new Proxy(function () {} as never, {
      get: (_target, property) => (property === 'then' ? undefined : () => Promise.resolve(undefined)),
      apply: () => Promise.resolve(undefined)
    });

  /** Opens a webview and returns the HTML it produced. */
  const capturePanel = (): { html: () => string } => {
    let html = '';
    const webview = {
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(true),
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({ toString: () => `https://cdn${uri.fsPath}` })),
      cspSource: 'https://cdn.test'
    };
    Object.defineProperty(webview, 'html', {
      get: () => html,
      set: (value: string) => { html = value; },
      configurable: true
    });
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
      webview,
      reveal: vi.fn(),
      onDidDispose: vi.fn(),
      onDidChangeViewState: vi.fn(),
      dispose: vi.fn()
    } as never);
    return { html: () => html };
  };

  /** The sources the content security policy allows images from. */
  const imageSources = (html: string): string[] => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const part = csp.split(';').find((piece) => piece.trim().startsWith('img-src')) ?? '';
    return part.replace(/^\s*img-src\s*/, '').split(/\s+/).filter(Boolean);
  };

  const context = { extensionUri: vscode.Uri.file('/ext'), subscriptions: [] } as never;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  const profileStore = {
    listProfilesSync: () => [{ serverUrl: 'https://fm.example.com/fmi/data' }],
    listProfiles: () => Promise.resolve([{ serverUrl: 'https://fm.example.com/fmi/data' }])
  } as never;

  it.each(['recordEditor', 'recordViewer'] as const)('%s allows an image from the server of a profile', async (surface) => {
    const captured = capturePanel();
    if (surface === 'recordEditor') {
      const { RecordEditorPanel } = await import('../../src/webviews/recordEditor/index');
      (RecordEditorPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
      RecordEditorPanel.createOrShow(context, profileStore, loose(), loose(), logger);
    } else {
      const { RecordViewerPanel } = await import('../../src/webviews/recordViewer/index');
      (RecordViewerPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
      RecordViewerPanel.createOrShow(context, profileStore, loose(), logger);
    }
    const sources = imageSources(captured.html());
    // A container image is served by the FileMaker server of a profile.
    expect(sources).toContain('https://fm.example.com');
    // Every host on the internet stays out of the webview.
    expect(sources).not.toContain('https:');
  });
});
