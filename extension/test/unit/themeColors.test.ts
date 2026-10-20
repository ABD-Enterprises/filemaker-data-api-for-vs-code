import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
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
