import { readFileSync } from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * Narrow-editor guards. The real check is the UI journey J14 (e2e-ui, real VS Code at 360-1100 px); these keep
 * the rules that fixed it from being deleted by accident.
 */
const root = path.resolve(__dirname, '../../..');
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

const PAGES = ['recordEditor', 'recordViewer', 'scriptRunner', 'queryBuilder', 'connectionWizard'] as const;

describe('page stylesheets keep long layout names and controls inside the panel', () => {
  for (const page of PAGES) {
    it(`${page}: a <select> is as wide as its panel and clips a long option (full text in the tooltip)`, () => {
      const css = read(`src/webviews/${page}/ui/styles.css`);
      expect(css).toMatch(/select \{[^}]*width: 100%;[^}]*text-overflow: ellipsis;/s);
      expect(css).toMatch(/textarea \{[^}]*max-width: 100%;[^}]*min-width: 0;/s);
      expect(css).toMatch(/\.container,[^{]*\.panel,[^{]*\{[^}]*min-width: 0;/s);
      expect(css).toMatch(/pre \{[^}]*white-space: pre-wrap;/s);
    });
  }

  it('the layout lists put the full name in the option tooltip', () => {
    for (const [file, pattern] of [
      ['src/webviews/recordEditor/ui/index.js', /option\.textContent = layout;\s*option\.title = layout;/],
      ['src/webviews/recordViewer/ui/index.js', /option\.textContent = layout;\s*option\.title = layout;/],
      ['src/webviews/scriptRunner/ui/index.js', /option\.textContent = label;\s*option\.title = label;/],
      ['src/webviews/queryBuilder/ui/index.js', /option\.textContent = label;\s*option\.title = label;/]
    ] as const) {
      expect(read(file), file).toMatch(pattern);
    }
  });

  it('Query Builder menus open in the flow on a narrow panel instead of running off it', () => {
    const css = read('src/webviews/queryBuilder/ui/styles.css');
    expect(css).toMatch(/@media \(max-width: 640px\)\s*\{[^}]*\.menu-items \{[^}]*position: static;/s);
  });
});

describe('every webview stylesheet is well formed', () => {
  // A missing closing brace is not an error to a browser: the open block runs to the end of the file and every rule after it
  // is silently nested inside it. That is how the narrow-editor rules stopped applying to the Query Builder in 1.5.0.
  for (const file of [
    ...PAGES.map((page) => `src/webviews/${page}/ui/styles.css`),
    'src/webviews/schemaDiff/ui/styles.css',
    '../designer-ui/src/styles.css'
  ]) {
    it(`${file}: braces balance`, () => {
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css.split('{').length, file).toBe(css.split('}').length);
    });
  }
});

describe('Layout Mode and Diagnostics', () => {
  it('Layout Mode field names cannot widen the page', () => {
    const css = read('../designer-ui/src/styles.css');
    expect(css).toMatch(/\.field-list \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.field-chip \{[^}]*overflow-wrap: anywhere;/);
  });

  it('Layout Mode narrows its three columns and stacks them in a narrow editor', () => {
    const css = read('../designer-ui/src/styles.css');
    expect(css).toMatch(/@media \(max-width: 1320px\)\s*\{\s*\.app-shell \{\s*grid-template-columns: 220px minmax\(0, 1fr\) 240px;/);
    expect(css).toMatch(/@media \(max-width: 860px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\);[\s\S]*height: auto;/);
  });

  it('Diagnostics scrolls its tables inside their cards, and its buttons and stat tiles wrap', () => {
    const source = read('src/diagnostics/diagnosticsDashboard.ts');
    expect(source.match(/<div class="table-scroll"><table>/g)).toHaveLength(2);
    expect(source).toContain('.table-scroll { overflow-x: auto;');
    expect(source).toMatch(/\.actions \{ display: flex; flex-wrap: wrap;/);
    expect(source).toContain('minmax(min(150px, 100%), 1fr)');
  });
});
