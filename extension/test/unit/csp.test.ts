import { describe, it, expect } from 'vitest';
import type * as vscode from 'vscode';

import { createNonce, buildWebviewCsp } from '../../src/webviews/common/csp';

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
});
