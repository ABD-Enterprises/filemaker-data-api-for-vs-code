import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { createBlankLayout } from '../../src/fmweb/layoutSchema';
import { LayoutModePanel } from '../../src/webviews/layoutMode';

describe('Layout Mode metadata handoff', () => {
  it.each(['created', 'existing'])('passes ordered typed fields and offers templates only for a %s layout', async (source) => {
    let receive: ((message: unknown) => void) | undefined;
    let dispose: (() => void) | undefined;
    const posted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
      webview: {
        html: '', cspSource: 'vscode-resource:', asWebviewUri: (uri: unknown) => uri,
        postMessage: vi.fn(async (message) => { posted.push(message); return true; }),
        onDidReceiveMessage: (callback: (message: unknown) => void) => { receive = callback; }
      },
      onDidDispose: (callback: () => void) => { dispose = callback; }, reveal: vi.fn()
    } as never);
    const layout = createBlankLayout(' Web ', ' Source ');
    const metadata = [{ layoutName: ' Source ', fields: [{ name: ' Z', type: 'number' }, { name: 'A', type: 'container' }], portals: [] }];
    const service = {
      ensureProjectInitialized: vi.fn(async () => ({ name: 'Project' })),
      loadOrCreateLayout: vi.fn(async () => ({ layout, source })),
      loadMetadataCache: vi.fn(async () => ({ scripts: [] })),
      getAvailableFields: vi.fn(async () => [' Z', 'A']),
      getDesignerLayouts: vi.fn(async () => metadata)
    };
    try {
      LayoutModePanel.createOrShow(
        { extensionUri: vscode.Uri.file('/ext') } as never, service as never, {} as never, {} as never,
        { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        { assertScriptRunAllowed: async () => true }
      );
      receive?.({ type: 'ready' });
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({ type: 'init', payload: {
        layout, availableFields: [' Z', 'A'], availableFieldMetadata: metadata[0]?.fields,
        isNewLayout: source === 'created'
      } });
      expect(posted[0]?.payload.templateLayouts).toEqual(source === 'created' ? metadata : undefined);
      expect(service.getAvailableFields).toHaveBeenCalledWith(' Source ');
    } finally {
      dispose?.();
    }
  });
});
