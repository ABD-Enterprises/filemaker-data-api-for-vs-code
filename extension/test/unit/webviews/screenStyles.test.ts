import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';

const root = path.resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const pages = ['connectionWizard', 'queryBuilder', 'recordViewer', 'recordEditor', 'scriptRunner', 'schemaDiff', 'layoutMode'];
const inline = ['extension/src/diagnostics/diagnosticsDashboard.ts', 'extension/src/settings/effectiveSettings.ts', 'extension/src/webviews/environmentCompare/index.ts', 'extension/src/webviews/common/panelRestore.ts'];
function sharedCss(): string {
  const compiled = buildSync({ entryPoints: [path.join(root, 'shared/src/field-standards.ts')], bundle: true, format: 'cjs', write: false }).outputFiles[0]!.text;
  const module = { exports: {} as { standardFieldsCss: (webview?: boolean) => string } };
  new Function('module', compiled)(module);
  return module.exports.standardFieldsCss(true);
}

describe('one stylesheet for extension screens', () => {
  it('owns font, size, panels, controls, headings, buttons, read-only fields, banners, tables and links', () => {
    const css = sharedCss();
    for (const token of ['--vscode-font-family', '--vscode-font-size, 13px', '--fm-page-width: 1200px', '--fm-control-radius: 4px', '--fm-panel-radius: 8px', '--fm-panel-padding: 16px', '--vscode-disabledForeground', '--vscode-input-background', '--vscode-contrastBorder', '--vscode-focusBorder', '--vscode-button-secondaryBackground', '--vscode-textLink-foreground', '--vscode-inputValidation-errorBackground', '--vscode-inputValidation-warningBackground', '--vscode-inputValidation-infoBackground']) expect(css).toContain(token);
    expect(css).toMatch(/h1\s*\{[^}]*font-size: 1\.6em/);
    expect(css).toMatch(/h2\s*\{[^}]*font-size: 1\.2em/);
    expect(css).toMatch(/input, select, textarea\s*\{[^}]*font: inherit/);
    expect(css).toMatch(/\.fm-code\s*\{[^}]*font-family: var\(--vscode-editor-font-family/);
    expect(css).toMatch(/input:disabled,[\s\S]*\[readonly\],[\s\S]*\.fm-readonly\s*\{[^}]*resize: none/);
    expect(css).toContain('button.secondary');
    expect(css).toContain('button:disabled');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('.fm-banner');
    expect(css).toContain('table {');
    const module = { exports: {} as { standardFieldsCss: () => string } };
    new Function('module', buildSync({ entryPoints: [path.join(root, 'shared/src/field-standards.ts')], bundle: true, write: false, format: 'cjs' }).outputFiles[0]!.text)(module);
    expect(module.exports.standardFieldsCss()).not.toContain('body {');
  });

  it('loads the shared sheet in every HTML builder and ships it beside every page', () => {
    for (const page of pages) {
      const builder = `extension/src/webviews/${page}/${page === 'queryBuilder' ? 'html' : page === 'layoutMode' ? 'panel' : 'index'}.ts`;
      const source = read(builder);
      expect(source, builder).toContain("'fieldStandards.css'");
      expect(source, builder).toContain('<link rel="stylesheet" href="${standardsStyleUri}"');
    }
    for (const builder of inline) {
      expect(read(builder), builder).toContain('<style nonce="${nonce}">${standardFieldsCss(true)}</style>');
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'fm-screen-styles-'));
    try {
      execFileSync(process.execPath, [path.join(root, 'extension/scripts/copy-webviews.mjs'), dir]);
      for (const page of pages) expect(readFileSync(path.join(dir, 'webviews', page, 'ui', 'fieldStandards.css'), 'utf8'), page).toBe(sharedCss());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('removes competing fonts, button paint, heading scales and banner paint from screen CSS', () => {
    // Canvas handles/selection and Schema Diff status cells are authored graphics, not page controls.
    // Menu hover/selection and sort-header hover are contextual table/menu state, not button defaults.
    // Table-cell badges (including ignored settings) retain their semantic state colors.
    const allowedButtonPaint = /(?:resize-handle|object-list button.selected|sort-header|menu-items button)/;
    const files = [...pages.map((page) => `extension/src/webviews/${page}/ui/${page === 'layoutMode' ? 'index' : 'styles'}.css`), 'designer-ui/src/styles.css', ...inline];
    for (const file of files) {
      const source = read(file);
      const css = file.endsWith('.css') ? source : [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
      expect(css, file).not.toMatch(/font-family\s*:/);
      for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, selector = '', body = ''] = match;
        if (/button|summary\.secondary|\.actions \.(?:primary|secondary)/.test(selector) && !allowedButtonPaint.test(selector)) expect(body, `${file}: ${selector}`).not.toMatch(/background(?:-color)?\s*:/);
        if (/\.status\.(?:error|warning|success)|\.fm-banner|\.template-banner|\.restricted-notice|\.conflict\s*$/.test(selector)) expect(body, `${file}: ${selector}`).not.toMatch(/background|border:|color:/);
        if (/(?:^|[\s,])h[12](?:\s|,|$)/.test(selector)) expect(body, `${file}: ${selector}`).not.toMatch(/font-size:/);
      }
    }
  });

  it('gives Diagnostics and Effective Settings one page title and keeps editor and result polish in CSS', () => {
    expect(read(inline[0]!)).toContain('<h1>FileMaker Diagnostics Dashboard</h1>');
    expect(read(inline[1]!)).toContain('<h1>Effective settings</h1>');
    const editor = read('extension/src/webviews/recordEditor/index.ts');
    for (const id of ['loadButton', 'validateButton', 'previewButton', 'discardButton', 'exportButton']) expect(editor).toContain(`class="secondary" id="${id}"`);
    expect(sharedCss()).toContain('min-height: 32px');
    expect(read('extension/src/webviews/queryBuilder/html.ts')).toContain('<textarea class="fm-code" id="findJson"');
    expect(read('extension/src/webviews/scriptRunner/ui/index.js')).toContain("'builder-json-value fm-code'");
    expect(read('extension/src/webviews/recordEditor/ui/styles.css')).toMatch(/#hiddenNote\s*\{[^}]*margin-bottom: 16px/);
    expect(read('extension/src/webviews/recordEditor/ui/styles.css')).toMatch(/#patchPreview:empty\s*\{[^}]*display: none/);
    expect(read('extension/src/webviews/queryBuilder/ui/styles.css')).toMatch(/\.actions-col a\s*\{[^}]*white-space: nowrap[^}]*overflow-wrap: normal/);
    expect(read('extension/src/webviews/queryBuilder/ui/styles.css')).toMatch(/\.sort-header\s*\{[^}]*min-height: 0[^}]*white-space: nowrap/);
  });
});

// Keep the existing filter and its exact IDs: only the opening selection changes.
describe.skipIf(!JSDOM)('Schema Diff opening selection', () => {
  it('starts with changes and lets the owner show unchanged fields', () => {
    const source = read('extension/src/webviews/schemaDiff/index.ts');
    const body = source.slice(source.indexOf('<main class="container">'), source.indexOf('</main>') + 7);
    const page = loadPage(`<body>${body}</body>`, 'window.requestAnimationFrame = (callback) => callback();\n' + read('extension/src/webviews/schemaDiff/ui/index.js')); 
    page.send({ type: 'diff', payload: { summary: { added: 1, removed: 0, changed: 0 }, added: [{ name: 'Added', type: 'text' }], removed: [], changed: [], unchanged: [{ name: 'Same', type: 'text' }] } });
    expect(page.document.getElementById('changesOnly')?.getAttribute('checked')).not.toBeNull();
    expect(page.document.getElementById('sideBySide')?.textContent).not.toContain('Same');
    const toggle = page.document.getElementById('changesOnly')!;
    toggle.click();
    expect(page.document.getElementById('sideBySide')?.textContent).toContain('Same');
  });
});

it('documents every contributed command in the user guide reference table', () => {
  const manifest = JSON.parse(read('extension/package.json')) as { contributes: { commands: { title: string }[] } };
  const guide = read('extension/docs/USER_GUIDE.md');
  const table = guide.slice(guide.indexOf('## Command reference'), guide.indexOf('\n## ', guide.indexOf('## Command reference') + 4));
  for (const command of manifest.contributes.commands) expect(table).toContain(`| ${command.title.replace(/^FileMaker: /, '')} |`);
});
