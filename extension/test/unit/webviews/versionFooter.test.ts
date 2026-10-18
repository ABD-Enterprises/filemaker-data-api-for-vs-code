import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { build } from 'esbuild';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';


/** Answers every call with a resolved undefined, so a panel constructor can run against it. */
const loose = (): never =>
  new Proxy(function () {} as never, {
    get: (_target, property) => (property === 'then' ? undefined : () => Promise.resolve(undefined)),
    apply: () => Promise.resolve(undefined)
  });

function capturePanel(): { html: () => string } {
  let html = '';
  const webview = {
    onDidReceiveMessage: vi.fn(),
    postMessage: vi.fn().mockResolvedValue(true),
    asWebviewUri: vi.fn((uri: { fsPath: string }) => ({ toString: () => `https://cdn${uri.fsPath}` })),
    cspSource: 'https://cdn.test'
  };
  Object.defineProperty(webview, 'html', { get: () => html, set: (value: string) => {
      html = value;
    }, configurable: true });
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview,
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    onDidChangeViewState: vi.fn(),
    dispose: vi.fn()
  } as never);
  return { html: () => html };
}

const context = {
  extensionUri: vscode.Uri.file('/ext'),
  subscriptions: [],
  globalState: { get: vi.fn(), update: vi.fn() },
  workspaceState: { get: vi.fn(), update: vi.fn() }
} as never;

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

/** Opens each webview with stubbed services and returns the HTML it produced. */
const panels: Record<string, () => Promise<void>> = {
  connectionWizard: async () => {
    const { ConnectionWizardPanel } = await import('../../../src/webviews/connectionWizard/index');
    ConnectionWizardPanel.createOrShow(context, loose(), loose(), loose(), logger);
  },
  queryBuilder: async () => {
    const { QueryBuilderPanel } = await import('../../../src/webviews/queryBuilder/index');
    QueryBuilderPanel.createOrShow(context, loose(), loose(), loose(), logger, undefined, loose());
  },
  recordEditor: async () => {
    const { RecordEditorPanel } = await import('../../../src/webviews/recordEditor/index');
    RecordEditorPanel.createOrShow(context, loose(), loose(), loose(), logger);
  },
  recordViewer: async () => {
    const { RecordViewerPanel } = await import('../../../src/webviews/recordViewer/index');
    RecordViewerPanel.createOrShow(context, loose(), loose(), logger);
  },
  scriptRunner: async () => {
    const { ScriptRunnerPanel } = await import('../../../src/webviews/scriptRunner/index');
    ScriptRunnerPanel.createOrShow(context, loose(), loose(), logger);
  },
  layoutMode: async () => {
    const { LayoutModePanel } = await import('../../../src/webviews/layoutMode/panel');
    LayoutModePanel.createOrShow(context, loose(), loose(), loose(), logger, {} as never);
  },
  schemaDiff: async () => {
    const { SchemaDiffPanel } = await import('../../../src/webviews/schemaDiff/index');
    SchemaDiffPanel.createOrShow(context, { baseSnapshot: {}, targetSnapshot: {}, changes: [], summary: {} } as never);
  },
  environmentCompare: async () => {
    const { EnvironmentComparePanel } = await import('../../../src/webviews/environmentCompare/index');
    EnvironmentComparePanel.createOrShow({});
  },
  diagnosticsDashboard: async () => {
    const { DiagnosticsDashboardPanel } = await import('../../../src/diagnostics/diagnosticsDashboard');
    DiagnosticsDashboardPanel.createOrShow(
      { getSummary: () => ({ endpoints: [] }), clear: vi.fn() } as never,
      { listEntries: () => [], clear: vi.fn() } as never
    );
  }
};

describe('version footer in every webview', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    (await import('../../../src/about/runtimeVersion')).setRuntimeVersion('7.8.9');
  });

  for (const [name, open] of Object.entries(panels)) {
    it(`${name} renders the version footer`, async () => {
      const captured = capturePanel();
      await open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(captured.html(), name).toContain('<footer class="fm-version">FileMaker Data API Tools v7.8.9</footer>');
    });
  }
});

describe('packaged stylesheets carry the footer rule', () => {
  const root = join(__dirname, '..', '..', '..');
  const uiDir = (name: string): string => join(root, 'src', 'webviews', name, 'ui');
  const withSheet = ['connectionWizard', 'queryBuilder', 'recordEditor', 'recordViewer', 'scriptRunner', 'schemaDiff'];

  for (const name of withSheet) {
    it(`${name} ships .fm-version in its stylesheet`, () => {
      const sheets = readdirSync(uiDir(name)).filter((file) => file.endsWith('.css'));
      expect(sheets.map((file) => readFileSync(join(uiDir(name), file), 'utf8')).join('\n')).toContain('.fm-version');
    });
  }

  // `copy:webviews` copies the extension's Layout Mode folder and THEN copies the designer-ui
  // bundle over it, so the shipped index.css is the designer-ui one. Build exactly that bundle.
  it('layout mode ships .fm-version in the designer-ui bundle that overwrites index.css', async () => {
    const result = await build({
      entryPoints: [join(root, '..', 'designer-ui', 'src', 'main.tsx')],
      bundle: true,
      write: false,
      outdir: 'out',
      platform: 'browser',
      format: 'iife',
      minify: true,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' }
    });
    const css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
    expect(css).toContain('.fm-version');
    const rule = /\.fm-version\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const declarations = Object.fromEntries(rule.split(';').filter(Boolean).map((part) => part.split(/:(.*)/s).slice(0, 2).map((text) => text.trim())));
    // Pinned to a corner, over the content, never in the way of a click, and muted but readable.
    expect(declarations['position']).toBe('fixed');
    expect(declarations['right']).toBe('8px');
    expect(declarations['bottom']).toBe('4px');
    expect(declarations['font-size']).toBe('11px');
    expect(declarations['color']).toBe('var(--ink)');
    expect(declarations['opacity']).toMatch(/^0?\.7$/);
    expect(declarations['pointer-events']).toBe('none');
  });

  it("the extension's own Layout Mode stylesheet (the fallback copied first) carries the footer too", () => {
    const css = readFileSync(join(uiDir('layoutMode'), 'index.css'), 'utf8');
    expect(css).toMatch(/\.fm-version\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.fm-version\s*\{[^}]*pointer-events:\s*none/);
  });

  it('the packaged dist stylesheets match, when a build exists', () => {
    const dist = join(root, 'dist', 'webviews', 'layoutMode', 'ui', 'index.css');
    let css: string;
    try {
      css = readFileSync(dist, 'utf8');
    } catch {
      return; // CI runs the tests before the build; the bundle check above covers that order.
    }
    expect(css).toContain('.fm-version');
  });
});
