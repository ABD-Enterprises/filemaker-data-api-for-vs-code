import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../../..');
// All CSS named colors, not just the common white/black/red spellings.
const names = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

function unthemed(value: string): string {
  let result = '';
  for (let index = 0; index < value.length;) {
    const start = /^var\(\s*--vscode-[\w-]+\s*,/i.exec(value.slice(index));
    if (!start) { result += value[index++]; continue; }
    let depth = 1;
    index += start[0].length;
    while (index < value.length && depth) {
      if (value[index] === '(') depth++;
      if (value[index] === ')') depth--;
      index++;
    }
    result += ' theme-token ';
  }
  return result;
}

function violations(css: string): string[] {
  const failures: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const declaration of clean.matchAll(/(?:^|[;{}])\s*([\w-]+)\s*:\s*([^;{}]+)/g)) {
    const property = declaration[1]!;
    const value = declaration[2]!;
    const remaining = unthemed(value).replace(/(['"])(?:\\.|(?!\1).)*?\1/g, '');
    const tokens = remaining.match(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|\b[a-z]+\b/gi) ?? [];
    if (tokens.some((token) => token.startsWith('#') || token.includes('(') || names.has(token.toLowerCase()))) {
      failures.push(`${property}: ${value.trim()}`);
    }
  }
  return failures;
}

describe('webview theme color regression guard', () => {
  it('scans every designer/webview stylesheet and inline style block', () => {
    const files = [...filesIn(path.join(root, 'designer-ui/src')), ...filesIn(path.join(root, 'extension/src'))];
    const styles = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      if (file.endsWith('.css')) {
        // The only direct literal allowed: neutral paper behind the authored page.
        // Generated runtime CSS is deliberately outside this editor-theme contract.
        const css = file === path.join(root, 'designer-ui/src/styles.css')
          ? source.replace(/\.design-surface \{ background-color: #ffffff; \}/, '') : source;
        return [{ file: path.relative(root, file), css }];
      }
      return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => ({
        file: path.relative(root, file), css: match[1]!
      })).concat([...source.matchAll(/\bstyle="([^"]*)"/g)].map((match) => ({
        file: path.relative(root, file), css: `{${match[1]}}`
      })));
    });
    // This is the source of fieldStandards.css copied into Query Builder, Viewer
    // and Editor. Its geometry is shared with runtime-next and must stay unchanged.
    const compiled = buildSync({ entryPoints: [path.join(root, 'shared/src/field-standards.ts')],
      bundle: true, write: false, platform: 'node', format: 'cjs' });
    const module = { exports: {} as { standardFieldsCss: () => string } };
    new Function('module', compiled.outputFiles[0]!.text)(module);
    styles.push({ file: 'shared/src/field-standards.ts (generated CSS)', css: module.exports.standardFieldsCss() });
    expect(styles.length).toBeGreaterThanOrEqual(12);
    expect(styles.flatMap(({ file, css }) => violations(css).map((value) => `${file}: ${value}`))).toEqual([]);
  });

  it.each(['#123456', 'rgb(1, 2, 3)', 'hsl(0 50% 50%)', 'rebeccapurple', 'WHITE', 'oklch(50% .2 30)'])('rejects a hardcoded %s', (color) => {
    expect(violations(`.mutation { color: ${color}; }`)).toHaveLength(1);
  });

  it('allows theme fallbacks, including semantic diff colors, without hiding adjacent literals', () => {
    expect(violations('.diff { background: var(--vscode-diffEditor-insertedTextBackground, rgba(19, 115, 51, .1)); }')).toEqual([]);
    expect(violations('.x { border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, #ccc)); color: #abc; }')).toHaveLength(1);
    expect(violations('.x { background: var(--vscode-editor-background, #fff) red; }')).toHaveLength(1);
    expect(violations('.x { color: var(--local-color, #fff); }')).toHaveLength(1);
  });
});

// Load the same pure audit code used by the offline CLI, without launching Chrome
// or depending on a developer's VS Code installation in unit tests.
interface ContrastPair { selector: string; ratio: number; foreground: number[]; typedForeground?: number[] }
interface ThemeAudit {
  themes: [string, string][];
  registrations: Record<string, (string | null)[]>;
  tokensFor: (theme: string, overrides?: Record<string, string | null>) => Record<string, string>;
  resolveVars: (value: string, tokens: Record<string, string | null | undefined>, stack?: string[], missing?: string[]) => string;
  resolvedCss: (css: string, tokens: Record<string, string>, missing?: string[]) => string;
  measure: (css: string, body: string, tokens: Record<string, string>, excluded?: unknown[]) => ContrastPair[];
  presentationFailures: (css: string, body: string, tokens: Record<string, string>) => string[];
}
const compiledAudit = buildSync({ entryPoints: [path.join(root, 'tools/theme-audit-colors.mjs')],
  bundle: true, packages: 'external', write: false, platform: 'node', format: 'cjs' });
const auditModule = { exports: {} as ThemeAudit };
new Function('module', 'exports', 'require', compiledAudit.outputFiles[0]!.text)(auditModule, auditModule.exports, createRequire(import.meta.url));
const audit = auditModule.exports;
const styleFiles = [path.join(root, 'designer-ui/src/styles.css'), ...filesIn(path.join(root, 'extension/src'))];
const auditedStyles = styleFiles.flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return file.endsWith('.css') ? [{ file, css: source }] : [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => ({ file, css: match[1]! }));
});
const stylesheet = (page: string) => readFileSync(path.join(root, `extension/src/webviews/${page}/ui/styles.css`), 'utf8');
const designerCss = readFileSync(path.join(root, 'designer-ui/src/styles.css'), 'utf8');
const fieldFixture = '<section class="panel pane form-section"><input placeholder="Hint" value="Typed text"><textarea placeholder="Hint">Typed text</textarea><button id="excluded" disabled>Disabled</button></section>';
const diffFixture = ['field-cell', 'tree-leaf'].map((base) => ['added','removed','changed','unchanged'].map((state) => `<div class="${base} ${state}"><span class="status-badge ${state}">${state}</span><div class="field-title">Customer</div>${base === 'field-cell' ? '<dl class="field-meta"><dt>Type</dt><dd>Text</dd></dl>' : '<span class="tree-field-type">Text</span><ul class="change-list"><li>Type changed</li></ul>'}</div>`).join('')).join('');
const successFixture = '<section class="panel"><p class="status success">Success</p><span class="test-badge success">Passed</span></section>';
const gridFixture = '<div class="design-surface"><div data-mode="designer"><input value="Authored field"></div><div class="interaction-layer"><div class="object-hitbox">Field</div></div></div>';

describe('offline theme audit regression guards', () => {
  it('audits both high contrast variants and never invents null registrations', () => {
    expect(audit.themes.map(([theme]) => theme)).toEqual(['light', 'dark', 'high-contrast', 'high-contrast-light']);
    for (const [index, [theme]] of audit.themes.entries()) {
      const tokens = audit.tokensFor(theme);
      for (const [key, values] of Object.entries(audit.registrations)) {
        if (values[index] == null) expect(tokens).not.toHaveProperty(`--vscode-${key.replaceAll('.', '-')}`);
      }
    }
    expect(audit.tokensFor('high-contrast')).not.toHaveProperty('--vscode-textBlockQuote-background');
    expect(audit.tokensFor('light', { 'input.background': null })).not.toHaveProperty('--vscode-input-background');
  });

  it.each([null, undefined])('uses literal fallback for an absent %s token (P1 mutation)', (value) => {
    const missing: string[] = [];
    const tokens = value === null ? { '--vscode-textBlockQuote-background': null } : {};
    expect(audit.resolveVars('var(--vscode-textBlockQuote-background, #ffffff)', tokens, [], missing)).toBe('#ffffff');
    expect(missing).toEqual(['--vscode-textBlockQuote-background']);
    const bad = stylesheet('connectionWizard').replace(/--panel: [^;]+;/, '--panel: var(--vscode-textBlockQuote-background, #ffffff);');
    expect(audit.measure(bad, '<section class="form-section">White on white</section>', audit.tokensFor('high-contrast'))[0]!.ratio).toBe(1);
  });

  it.each(audit.themes)('%s resolves every production color fallback to a registered token', (theme) => {
    for (const { file, css } of auditedStyles) {
      const missing: string[] = [];
      audit.resolvedCss(css, audit.tokensFor(theme), missing);
      expect([...new Set(missing)], file).toEqual([]);
    }
  });

  it.each(audit.themes)('%s keeps hints distinct and secondary text readable', (theme) => {
    const tokens = audit.tokensFor(theme);
    for (const css of [designerCss, ...['connectionWizard','recordEditor','recordViewer','queryBuilder','schemaDiff','scriptRunner'].map(stylesheet)]) {
      for (const colors of [tokens, Object.fromEntries(Object.entries(tokens).filter(([key]) => key !== '--vscode-input-placeholderForeground'))]) {
        const excluded: unknown[] = [];
        const pairs = audit.measure(css, fieldFixture, colors, excluded);
        expect(excluded).toHaveLength(1);
        expect(pairs.every((pair) => pair.ratio >= 4.5)).toBe(true);
        expect(pairs.filter((pair) => pair.selector.endsWith('::placeholder'))).toHaveLength(2);
        expect(audit.presentationFailures(css, fieldFixture, colors)).toEqual([]);
      }
    }
  });

  it('detects placeholder and secondary hierarchy mutations', () => {
    const tokens = audit.tokensFor('light');
    const css = stylesheet('connectionWizard');
    const typedHint = css + 'input::placeholder, textarea::placeholder { color:var(--vscode-input-foreground); }';
    expect(audit.presentationFailures(typedHint, fieldFixture, tokens)).toContain('placeholder matches typed text');
    const primaryMuted = css.replace(/--muted: [^;]+;/, '--muted: var(--vscode-foreground);');
    expect(audit.presentationFailures(primaryMuted, fieldFixture, tokens)).toContain('secondary hierarchy or contrast');
  });

  it.each(audit.themes)('%s keeps success/OK green and readable, catching a blue mutation', (theme) => {
    const tokens = audit.tokensFor(theme);
    const environment = auditedStyles.find(({ file }) => file.replace(/\\/g, '/').endsWith('/environmentCompare/index.ts'))!.css;
    for (const [css, body] of [[stylesheet('connectionWizard'), successFixture], [environment, '<section class="card"><span class="ok">OK</span></section>']]) {
      expect(audit.presentationFailures(css!, body!, tokens)).toEqual([]);
      expect(audit.measure(css!, body!, tokens).every((pair) => pair.ratio >= 4.5)).toBe(true);
      expect(audit.presentationFailures(css + '.status.success, .test-badge.success, .ok { background: var(--vscode-inputValidation-infoBackground); }', body!, tokens)).toContain('success background is not green');
    }
  });

  it('keeps HC Light menu selection text paired with its pale background', () => {
    const tokens = audit.tokensFor('high-contrast-light');
    const css = stylesheet('queryBuilder').replaceAll(':hover', ':not(.audit-never)');
    const body = '<details class="menu" open><summary>Copy</summary><div class="menu-items"><button>Copy as curl</button></div></details>';
    expect(audit.measure(css, body, tokens).every((pair) => pair.ratio >= 4.5)).toBe(true);
    const mutation = css.replace('var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, var(--text)))', 'var(--vscode-menu-selectionForeground, var(--accent-text))');
    expect(audit.measure(mutation, body, tokens).some((pair) => pair.ratio < 4.5)).toBe(true);
  });

  it.each(audit.themes.filter(([theme]) => theme.startsWith('high-contrast')))('%s distinguishes every diff cell/tree marker and catches each mutation', (theme) => {
    const tokens = audit.tokensFor(theme), css = stylesheet('schemaDiff');
    expect(audit.presentationFailures(css, diffFixture, tokens)).toEqual([]);
    expect(audit.measure(css, diffFixture, tokens).every((pair) => pair.ratio >= 4.5)).toBe(true);
    for (const state of ['added','removed','changed']) {
      const mutation = css + `.field-cell.${state}, .tree-leaf.${state} { border-style:solid; border-color:var(--border); }`;
      expect(audit.presentationFailures(mutation, diffFixture, tokens).some((failure) => failure.includes(state))).toBe(true);
    }
  });

  it('keeps the grid below objects and catches the inherited overlay mutation', () => {
    const tokens = audit.tokensFor('dark');
    expect(audit.presentationFailures(designerCss, gridFixture, tokens)).toEqual([]);
    expect(audit.presentationFailures(designerCss + '.design-surface > [data-mode="designer"] { background-image:none; }', gridFixture, tokens)).toContain('missing grid below objects');
    expect(audit.presentationFailures(designerCss + '.interaction-layer { background-image:inherit; background-size:inherit; }', gridFixture, tokens)).toContain('grid over objects');
  });
});
