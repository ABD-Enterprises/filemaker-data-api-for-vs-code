import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('Viewer boxes exact read-only values and overlays Copy without another field row', async () => {
    const page = loadPage(html('recordViewer'), read('extension/src/webviews/recordViewer/ui/index.js'));
    const exact = '  first line\nsecond line  ';
    const values = { ' Text ': '  unchanged  ', Notes: exact, Unknown: 'x'.repeat(500), Photo: 'container-url' };
    const payload = { record: { recordId: '1', fieldData: values, portalData: { Related: [{ recordId: '2' }] } }, presentationFields: fields };
    page.send({ type: 'recordLoaded', payload });
    page.window.eval(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copied = text; } } });`);
    const rows = page.document.querySelectorAll('#fieldDataContainer tbody tr');
    expect(rows).toHaveLength(4);
    for (const [index, [name, value]] of Object.entries(values).entries()) {
      const row = rows[index]!;
      const label = row.querySelector('td')!;
      const control = row.querySelector('textarea')!;
      expect(control).not.toBeNull();
      expect(control.getAttribute('readonly')).not.toBeNull();
      expect(control.getAttribute('aria-label')).toBe(name);
      expect(control.getAttribute('aria-labelledby')).toBe(label.id);
      expect(control.value).toBe(value);
      const button = row.querySelector('button')!;
      expect(button.textContent).toBe('Copy');
      expect(row.querySelector('td.fm-field-control')?.contains(button)).toBe(true);
      button.click();
      page.window.eval(`if (window.copied !== ${JSON.stringify(value)}) throw new Error('Copy changed the value');`);
    }
    assertSize(rows[0]!, 240, 34);
    assertSize(rows[1]!, 240, 96);
    assertSize(rows[2]!, 240, 96);
    assertSize(rows[3]!, 240, 160);
    expect(page.document.getElementById('rawJson')?.textContent).toBe(JSON.stringify(payload, null, 2));
    expect(page.document.getElementById('relatedDataContainer')?.textContent).toContain('Related (1)');
    // Same keys can change between short and long text without losing whitespace or Copy behavior.
    page.send({ type: 'recordLoaded', payload: { record: { fieldData: { ...values, Unknown: ' short ' } }, presentationFields: fields } });
    assertSize(page.document.querySelectorAll('#fieldDataContainer tbody tr')[2]!, 240, 34);
    expect(page.document.querySelectorAll('#fieldDataContainer textarea')[2]!.value).toBe(' short ');
    await Promise.resolve();
    expect(page.document.getElementById('status')?.textContent).toBe('Copied Photo.');
  });

  it('Viewer and Editor share control borders and padding, with Copy positioned out of field flow', () => {
    for (const surface of ['recordEditor', 'recordViewer'] as const) {
      const page = loadPage(html(surface), read(`extension/src/webviews/${surface}/ui/index.js`));
      page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData }, fields, presentationFields: fields } });
      page.window.eval(`const sheet = document.createElement('style');
        sheet.textContent = ${JSON.stringify(read(`extension/src/webviews/${surface}/ui/styles.css`))} + window.FieldStandards.standardFieldsCss(true);
        // jsdom does not resolve custom color properties inside border shorthands.
        sheet.textContent = sheet.textContent.replaceAll('var(--border)', '#d0d7de').replaceAll('var(--fm-control-radius)', '4px');
        document.head.appendChild(sheet);
        const control = document.querySelector('${surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer'} textarea');
        const style = getComputedStyle(control);
        if (style.borderTopWidth !== '1px' || style.borderTopStyle !== 'solid' || style.borderRadius !== '4px'
          || style.paddingTop !== '8px' || style.paddingBottom !== '8px' || style.paddingLeft !== '10px'
          || style.boxSizing !== 'border-box') throw new Error('${surface} control box differs from the standard input: ' + JSON.stringify([style.borderTopWidth, style.borderTopStyle, style.borderRadius, style.paddingTop, style.paddingBottom, style.paddingLeft, style.boxSizing]));
        ${surface === 'recordViewer' ? `
        const cell = control.parentElement;
        const copy = cell.querySelector('button');
        if (getComputedStyle(cell).position !== 'relative' || getComputedStyle(cell).padding !== '0px'
          || getComputedStyle(copy).position !== 'absolute' || getComputedStyle(copy).top !== '4px'
          || getComputedStyle(copy).right !== '4px') throw new Error('Copy must overlay the value box');
        if (getComputedStyle(control).paddingRight !== '58px' || getComputedStyle(control).overflow !== 'auto')
          throw new Error('Value text must remain reachable beside Copy');` : ''}
      `);
    }
  });

  it.each(['recordEditor', 'recordViewer', 'queryBuilder'] as const)('%s still renders when the standards script fails to load', (surface) => {
    const pageHtml = html(surface).replace('fieldStandards.js', 'missing.js');
    const source = (surface === 'queryBuilder' ? read('extension/src/webviews/queryBuilder/ui/findForm.js') + '\n' : '')
      + read(`extension/src/webviews/${surface}/ui/index.js`);
    const page = loadPage(pageHtml, source);
    if (surface === 'queryBuilder') {
      page.send({ type: 'init', payload: { profiles, activeProfileId: 'p', savedQueries: [] } });
      page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: ['Layout'] } });
      page.send({ type: 'fieldNamesLoaded', payload: { profileId: 'p', layout: 'Layout', fieldNames: [' Text '], fieldMetadata: fields } });
      const field = page.document.querySelectorAll('.criterion-field')[0]!;
      field.value = ' Text ';
      page.window.eval("document.querySelector('.criterion-field').dispatchEvent(new Event('input'))");
      expect(page.document.querySelectorAll('.criterion-value')).toHaveLength(1);
      page.document.getElementById('addSortButton')?.click();
      expect(page.document.querySelectorAll('.sort-field')).toHaveLength(1);
    } else {
      page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData }, fields, presentationFields: fields } });
      // Exercise both building and reusing cells.
      page.send({ type: 'recordLoaded', payload: { record: { recordId: '2', fieldData: { ...fieldData, Number: ' 2 ' } }, fields, presentationFields: fields } });
      const selector = surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer';
      expect(page.document.querySelectorAll(`${selector} tbody tr`)).toHaveLength(fields.length);
      expect(page.document.getElementById('status')?.textContent).toContain('2');
      if (surface === 'recordViewer') {
        expect(page.document.querySelectorAll(`${selector} .table-scroll-wrapper table`)).toHaveLength(1);
        expect(page.document.querySelectorAll(`${selector} .fm-field-table, ${selector} .fm-fields, ${selector} textarea`)).toHaveLength(0);
        const rows = page.document.querySelectorAll(`${selector} tbody tr`);
        rows.forEach((row) => {
          expect(row.querySelectorAll('td')).toHaveLength(3);
          expect(row.querySelectorAll('td:nth-child(2) > span')).toHaveLength(1);
          expect(row.querySelector('td:nth-child(3) > button')?.textContent).toBe('Copy');
        });
        expect(rows[1]?.querySelector('td:nth-child(2) > span')?.textContent).toBe(' 2 ');
      }
    }
  });

  it('Query Builder resizes values when the exact selected field changes, without changing find syntax', () => {
    const pageHtml = html('queryBuilder');
    const page = loadPage(pageHtml, read('extension/src/webviews/queryBuilder/ui/findForm.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/index.js'));
    page.send({ type: 'init', payload: { profiles, activeProfileId: 'p', savedQueries: [] } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: [' Layout '] } });
    page.send({ type: 'fieldNamesLoaded', payload: { profileId: 'p', layout: ' Layout ', fieldNames: fields.map((field) => field.name), fieldMetadata: fields } });
    page.window.eval(`const sheet = document.createElement('style');
      sheet.textContent = ${JSON.stringify(read('extension/src/webviews/queryBuilder/ui/styles.css'))} + window.FieldStandards.standardFieldsCss(true);
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
  const exports = { exports: {} as { standardFieldsCss: (webview?: boolean) => string } };
  new Function('module', compiled)(exports);
  const css = exports.exports.standardFieldsCss(true);
  for (const [width, height] of sizes) {
    expect(css).toContain(`[data-fm-width="${width}"] { --fm-field-width: ${width}px; }`);
    expect(css).toContain(`[data-fm-height="${height}"] { --fm-field-height: ${height}px; }`);
  }
  for (let count = 1; count <= 50; count += 1) {
    const height = Math.max(34, count * 24);
    expect(css).toContain(`[data-fm-height="${height}"] { --fm-field-height: ${height}px; }`);
  }
  expect(css).toContain('gap: 16px 24px');
  expect(css).toContain('min-height: 24px');
  expect(css).toContain('.fm-field > .fm-field-control { flex: none; }');
  expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*flex-direction: column/);
  expect(css.split('{')).toHaveLength(css.split('}').length);
  expect(css.length).toBeLessThan(18000);
  expect(compiled).not.toMatch(/require\(/);
  const outputDir = mkdtempSync(path.join(tmpdir(), 'filemaker-webviews-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'extension/scripts/copy-webviews.mjs'), outputDir], { cwd: root });
    for (const surface of ['queryBuilder', 'recordEditor', 'recordViewer']) {
      const output = path.join(outputDir, 'webviews', surface, 'ui', 'fieldStandards');
      expect(readFileSync(`${output}.css`, 'utf8')).toBe(css);
      expect(readFileSync(path.join(outputDir, 'webviews', surface, 'ui', 'index.js'), 'utf8')).toBe(read(`extension/src/webviews/${surface}/ui/index.js`));
      const browserBundle = readFileSync(`${output}.js`, 'utf8');
      expect(browserBundle).not.toMatch(/require\(/);
      const api = new Function(`${browserBundle}; return FieldStandards;`)() as { standardFieldSize: (field: { type: string }) => { width: number; height: number } };
      fields.forEach((field, index) => expect(api.standardFieldSize(field)).toEqual({ width: sizes[index]![0], height: sizes[index]![1] }));
    }
    for (const asset of ['index.js', 'index.css']) {
      const designerAsset = path.join(root, 'designer-ui/dist', asset);
      const expected = existsSync(designerAsset) ? designerAsset : path.join(root, 'extension/src/webviews/layoutMode/ui', asset);
      expect(readFileSync(path.join(outputDir, 'webviews/layoutMode/ui', asset), 'utf8')).toBe(readFileSync(expected, 'utf8'));
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
