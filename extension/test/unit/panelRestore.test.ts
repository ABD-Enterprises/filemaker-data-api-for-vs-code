import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { RESTORABLE_PANELS, registerPanelRestoreGuards, renderReopenPage } from '../../src/webviews/common/panelRestore';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('restored webview tabs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('every panel type the extension can open has a serializer (so a new panel cannot be added without one)', () => {
    const opened = new Set<string>();
    for (const file of sourceFiles(path.resolve(__dirname, '../../src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/createWebviewPanel\(\s*'([A-Za-z]+)'/g)) {
        opened.add(match[1] as string);
      }
    }
    expect(opened.size).toBeGreaterThanOrEqual(10);
    expect([...opened].filter((viewType) => !RESTORABLE_PANELS.some((panel) => panel.viewType === viewType))).toEqual([]);
    expect(RESTORABLE_PANELS.filter((panel) => !opened.has(panel.viewType))).toEqual([]); // and none for a type that does not exist
  });

  it('registers one serializer per view type, and each restored tab gets a static reopen page', async () => {
    const disposables = registerPanelRestoreGuards();
    expect(disposables).toHaveLength(RESTORABLE_PANELS.length);
    const calls = vi.mocked(vscode.window.registerWebviewPanelSerializer).mock.calls;
    expect(calls.map(([viewType]) => viewType).sort()).toEqual(RESTORABLE_PANELS.map((panel) => panel.viewType).sort());

    for (const [viewType, serializer] of calls) {
      const panel = { title: 'FileMaker Record Editor', webview: { html: '', cspSource: 'vscode-resource:' } };
      await serializer.deserializeWebviewPanel(panel as never, { restored: 'state', evil: '<script>x</script>' });
      expect(panel.webview.html, viewType).toContain('Close this tab and open it again');
      expect(panel.webview.html, viewType).toContain(RESTORABLE_PANELS.find((entry) => entry.viewType === viewType)?.reopenWith);
      // Nothing from the saved state, and nothing that can run.
      expect(panel.webview.html, viewType).not.toContain('evil');
      expect(panel.webview.html, viewType).not.toMatch(/<script/i);
    }
  });

  it('the page escapes the title, has a locked-down policy, and names a command that exists', () => {
    const html = renderReopenPage({ cspSource: 'x' }, '<img src=x onerror=alert(1)>', 'FileMaker: Open Query Builder');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; style-src 'nonce-[A-Za-z0-9+/=_-]+';"/);

    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { commands: Array<{ title: string; category?: string }> };
    };
    const titles = new Set(manifest.contributes.commands.map((command) => `${command.category ?? 'FileMaker'}: ${command.title}`));
    expect(RESTORABLE_PANELS.filter((panel) => !titles.has(panel.reopenWith)).map((panel) => panel.reopenWith)).toEqual([]);
  });
});
