import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';
import { JSDOM, loadPage, type DomElement } from '../../helpers/jsdomPage';
import { InMemoryMemento } from '../mocks';

const root = path.resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const profiles = [{ id: 'p', name: 'Profile', database: 'DB' }];
const fields = [
  { name: ' Text ', type: 'text' }, { name: 'Number', type: 'number' },
  { name: 'Date', type: 'date' }, { name: 'Time', type: 'time' }, { name: 'Stamp', type: 'timestamp' },
  { name: 'Notes', type: 'long text' }, { name: 'Photo', type: 'container' }
];
const sizes = [[240, 34], [120, 34], [160, 34], [160, 34], [160, 34], [240, 96], [240, 160]];
const fieldData = Object.fromEntries(fields.map((field) => [field.name, `Value of ${field.name}`]));
const classes = { queryBuilder: QueryBuilderPanel, recordEditor: RecordEditorPanel, recordViewer: RecordViewerPanel };
type Surface = keyof typeof classes;

function html(surface: Surface): string {
  const panel = { webview: { html: '', cspSource: 'webview:', asWebviewUri: (uri: unknown) => uri,
    postMessage: vi.fn(async () => true), onDidReceiveMessage: vi.fn() },
    onDidDispose: vi.fn(), reveal: vi.fn() };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as never);
  (classes[surface] as unknown as { currentPanel: unknown }).currentPanel = undefined;
  const context = { extensionUri: vscode.Uri.file('/extension'), workspaceState: new InMemoryMemento() } as never;
  const store = { listProfiles: vi.fn(async () => profiles), getActiveProfileId: () => 'p' } as never;
  if (surface === 'queryBuilder') QueryBuilderPanel.createOrShow(context, store, {} as never, {} as never, logger as never);
  if (surface === 'recordEditor') RecordEditorPanel.createOrShow(context, store, {} as never, {} as never, logger as never);
  if (surface === 'recordViewer') RecordViewerPanel.createOrShow(context, store, {} as never, logger as never);
  return panel.webview.html;
}

function assertSize(element: DomElement | null, width: number, height: number): void {
  expect(element).not.toBeNull();
  expect(element?.getAttribute('data-fm-width')).toBe(String(width));
  expect(element?.getAttribute('data-fm-height')).toBe(String(height));
  expect(element?.getAttribute('data-fm-label-position')).toBe('top');
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
});

describe.skipIf(!JSDOM)('standard field presentation in browser webviews', () => {
  it.each(['recordEditor', 'recordViewer'] as const)('%s uses typed widths with top labels and retains row selectors', (surface) => {
    const pageHtml = html(surface);
    expect(pageHtml).toContain('fieldStandards.css');
    expect(pageHtml).toMatch(/script nonce="[^"]+" src="[^"]*fieldStandards.js/);
    expect(pageHtml).not.toContain("'unsafe-inline'");
    const page = loadPage(pageHtml, read(`extension/src/webviews/${surface}/ui/index.js`));
    page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData }, fields, presentationFields: fields } });
    const container = surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer';
    const rows = page.document.querySelectorAll(`${container} tbody tr`);
    expect(rows).toHaveLength(fields.length);
    fields.forEach((field, index) => {
      const row = Array.from(rows).find((row) => row.querySelector('td')?.textContent === field.name)!;
      assertSize(row, sizes[index]![0]!, sizes[index]![1]!);
      const control = row.querySelector(surface === 'recordEditor' ? 'textarea' : 'td.fm-field-control');
      expect(control).not.toBeNull();
      if (surface === 'recordEditor') {
        expect(control?.getAttribute('aria-label')).toBe(field.name);
        const label = row.querySelector('td')!;
        // Journey J05 uses td:text-is(), which matches immediate text, not nested label text.
        expect(label.querySelectorAll('*')).toHaveLength(0);
        expect(control?.getAttribute('aria-labelledby')).toBe(label.id);
      }
    });
    // Same-key records must refresh sizing too; DOM reuse must not keep another layout's type.
    page.send({ type: 'recordLoaded', payload: { record: { recordId: '2', fieldData }, presentationFields: [] } });
    page.document.querySelectorAll(`${container} tbody tr`).forEach((row) => assertSize(row, 240, 34));
  });

  it('Query Builder resizes values when the exact selected field changes, without changing find syntax', () => {
    const pageHtml = html('queryBuilder');
    const page = loadPage(pageHtml, read('extension/src/webviews/queryBuilder/ui/findForm.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/index.js'));
    page.send({ type: 'init', payload: { profiles, activeProfileId: 'p', savedQueries: [] } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: [' Layout '] } });
    page.send({ type: 'fieldNamesLoaded', payload: { profileId: 'p', layout: ' Layout ', fieldNames: fields.map((field) => field.name), fieldMetadata: fields } });
    page.window.eval(`const sheet = document.createElement('style');
      sheet.textContent = ${JSON.stringify(read('extension/src/webviews/queryBuilder/ui/styles.css'))} + window.FieldStandards.standardFieldsCss();
      document.head.appendChild(sheet);`);
    page.window.eval(`if (getComputedStyle(document.querySelector('.criterion-value')).flexGrow !== '0') throw new Error('Find controls must not grow vertically inside top-label wrappers');`);
    page.document.getElementById('addSortButton')?.click();
    expect(page.document.querySelectorAll('.sort-editor .fm-fields')).toHaveLength(0);
    expect(page.document.querySelectorAll('.sort-field')).toHaveLength(1);
    const input = page.document.querySelectorAll('.criterion-field')[0]!;
    fields.forEach((field, index) => {
      input.value = field.name;
      page.window.eval("document.querySelector('.criterion-field').dispatchEvent(new Event('input'))");
      const value = page.document.querySelectorAll('.criterion-value')[0]!;
      const wrapper = page.document.querySelectorAll('.criterion-row .fm-field')[2]!;
      assertSize(wrapper, sizes[index]![0]!, sizes[index]![1]!);
      expect(wrapper.querySelector('.fm-field-label')?.textContent).toBe('Value');
      expect(value.getAttribute('aria-label')).toBe('Value');
    });
  });
});

it('the browser build generates bounded CSS from the shared rules, with narrow wrapping and no runtime dependencies', async () => {
  const compiled = buildSync({ entryPoints: [path.join(root, 'shared/src/field-standards.ts')],
    bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0]!.text;
  const exports = { exports: {} as { standardFieldsCss: () => string } };
  new Function('module', compiled)(exports);
  const css = exports.exports.standardFieldsCss();
  for (const [width, height] of sizes) {
    expect(css).toContain(`[data-fm-width="${width}"] { --fm-field-width: ${width}px; }`);
    expect(css).toContain(`[data-fm-height="${height}"] { --fm-field-height: ${height}px; }`);
  }
  expect(css).toContain('gap: 16px 24px');
  expect(css).toContain('min-height: 24px');
  expect(css).toContain('.fm-field > .fm-field-control { flex: none; }');
  expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*flex-direction: column/);
  expect(css.split('{')).toHaveLength(css.split('}').length);
  expect(css.length).toBeLessThan(10000);
  expect(compiled).not.toMatch(/require\(/);
  execFileSync(process.execPath, [path.join(root, 'extension/scripts/copy-webviews.mjs')], { cwd: root });
  for (const surface of ['queryBuilder', 'recordEditor', 'recordViewer']) {
    const output = `extension/dist/webviews/${surface}/ui/fieldStandards`;
    expect(read(`${output}.css`)).toBe(css);
    const browserBundle = read(`${output}.js`);
    expect(browserBundle).not.toMatch(/require\(/);
    const api = new Function(`${browserBundle}; return FieldStandards;`)() as { standardFieldSize: (field: { type: string }) => { width: number; height: number } };
    fields.forEach((field, index) => expect(api.standardFieldSize(field)).toEqual({ width: sizes[index]![0], height: sizes[index]![1] }));
  }
});
