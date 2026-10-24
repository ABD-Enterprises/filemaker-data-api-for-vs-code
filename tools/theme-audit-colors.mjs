// Offline snapshot of VS Code 1.142 color registrations (theme-defaults JSON
// overrides are applied separately). Columns: Light+, Dark+, HC Dark, HC Light.
// null is an absent custom property, NEVER a fabricated theme color.
import postcss from 'postcss';
import { JSDOM } from 'jsdom';

export const themes = [
  ['light', 'light_plus.json'], ['dark', 'dark_plus.json'],
  ['high-contrast', 'hc_black.json'], ['high-contrast-light', 'hc_light.json']
];
export const registrations = {
  foreground: ['#616161','#cccccc','#ffffff','#292929'],
  'editor.background': ['#ffffff','#1e1e1e','#000000','#ffffff'],
  'editor.foreground': ['#333333','#bbbbbb','#ffffff','#292929'],
  descriptionForeground: ['#717171','#ccccccb3','#ffffffb3','#292929b3'],
  'editorWidget.background': ['#f3f3f3','#252526','#0c141f','#ffffff'],
  'editorWidget.foreground': ['#616161','#cccccc','#ffffff','#292929'],
  'input.background': ['#ffffff','#3c3c3c','#000000','#ffffff'],
  'input.foreground': ['#616161','#cccccc','#ffffff','#292929'],
  'input.placeholderForeground': ['#61616180','#cccccc80','#ffffffb3','#292929b3'],
  'input.border': [null,null,'#6fc3df','#0f4a85'],
  'button.background': ['#007acc','#0e639c','#000000','#0f4a85'],
  'button.foreground': ['#ffffff','#ffffff','#ffffff','#ffffff'],
  'button.hoverBackground': ['#0062a3','#1177bb','#000000','#0f4a85'],
  'button.secondaryBackground': ['#f0f0f0','#2a2d2e',null,'#ffffff'],
  'button.secondaryHoverBackground': ['#ffffff','#323637',null,null],
  'button.secondaryForeground': ['#616161','#cccccc','#ffffff','#292929'],
  'list.hoverBackground': ['#f0f0f0','#2a2d2e','#ffffff1a','#0f4a851a'],
  'list.activeSelectionBackground': ['#0060c0','#04395e',null,'#0f4a851a'],
  'list.activeSelectionForeground': ['#ffffff','#ffffff',null,null],
  focusBorder: ['#0090f1','#007fd4','#f38518','#006bbd'],
  contrastBorder: [null,null,'#6fc3df','#0f4a85'],
  contrastActiveBorder: [null,null,'#f38518','#006bbd'],
  'panel.border': ['#80808059','#80808059','#6fc3df','#0f4a85'],
  errorForeground: ['#a1260d','#f48771','#f48771','#b5200d'],
  'textLink.foreground': ['#006ab1','#3794ff','#21a6ff','#0f4a85'],
  'diffEditor.insertedTextBackground': ['#9ccc2c40','#9ccc2c33',null,null],
  'diffEditor.removedTextBackground': ['#ff000033','#ff000033',null,null],
  'diffEditor.insertedTextBorder': [null,null,'#33ff2e','#374e06'],
  'diffEditor.removedTextBorder': [null,null,'#ff008f','#ad0707'],
  'inputValidation.infoBackground': ['#d6ecf2','#063b49','#000000','#ffffff'],
  'inputValidation.warningBackground': ['#f6f5d2','#352a05','#000000','#ffffff'],
  'inputValidation.errorBackground': ['#f2dede','#5a1d1d','#000000','#ffffff'],
  'inputValidation.infoForeground': [null,null,null,'#292929'],
  'inputValidation.warningForeground': [null,null,null,'#292929'],
  'inputValidation.errorForeground': [null,null,null,'#292929'],
  'inputValidation.infoBorder': ['#007acc','#007acc','#6fc3df','#0f4a85'],
  'inputValidation.warningBorder': ['#b89500','#b89500','#6fc3df','#0f4a85'],
  'inputValidation.errorBorder': ['#be1100','#be1100','#6fc3df','#0f4a85'],
  'editorWarning.foreground': ['#bf8803','#cca700','#ffd370','#895503'],
  'textCodeBlock.background': ['#dcdcdc66','#0a0a0a66','#000000','#f2f2f2'],
  'sideBar.background': ['#f3f3f3','#252526','#000000','#ffffff'],
  'textBlockQuote.background': ['#f2f2f2','#222222',null,'#f2f2f2'],
  'textBlockQuote.border': ['#007acc80','#007acc80','#ffffff','#292929'],
  'testing.iconPassed': ['#73c991','#73c991','#73c991','#007100'],
  'charts.green': ['#388a34','#89d185','#89d185','#374e06'],
  'progressBar.background': ['#0e70c0','#0e70c0','#6fc3df','#0f4a85'],
  'widget.shadow': ['#00000029','#0000005c',null,null],
  'widget.border': [null,null,'#6fc3df','#0f4a85'],
  disabledForeground: ['#61616180','#cccccc80','#a5a5a5','#7f7f7f'],
  'inputOption.activeBackground': ['#0090f133','#007fd466','#00000000','#00000000'],
  'editor.inactiveSelectionBackground': ['#add6ff80','#264f7880','#f3f518b3','#0f4a8580'],
  'menu.background': ['#ffffff','#3c3c3c','#000000','#ffffff'],
  'menu.foreground': ['#616161','#f0f0f0','#ffffff','#292929'],
  'menu.border': [null,null,'#6fc3df','#0f4a85'],
  'menu.selectionBackground': ['#0060c0','#04395e',null,'#0f4a851a'],
  'menu.selectionForeground': ['#ffffff','#ffffff',null,null]
};

export function tokensFor(theme, overrides = {}) {
  const index = themes.findIndex(([name]) => name === theme);
  if (index < 0) throw new Error(`Unknown theme ${theme}`);
  const values = { ...Object.fromEntries(Object.entries(registrations).map(([key, colors]) => [key, colors[index]])), ...overrides };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value != null).map(([key, value]) => [`--vscode-${key.replaceAll('.', '-')}`, value]));
}

// Track missing properties that actually reach a literal. Optional transparent
// outlines are intentional; a missing background/text token with #fff is not.
export function resolveVars(value, tokens, stack = [], missing = []) {
  let result = '';
  for (let i = 0; i < value.length;) {
    if (value.slice(i,i+4) !== 'var(') { result += value[i++]; continue; }
    let end = i+4, depth = 1, comma = -1;
    for (; end < value.length && depth; end++) {
      if (value[end] === '(') depth++;
      if (value[end] === ')') depth--;
      if (value[end] === ',' && depth === 1 && comma < 0) comma = end;
    }
    const key = value.slice(i+4, comma < 0 ? end-1 : comma).trim();
    const fallback = comma < 0 ? '' : value.slice(comma+1,end-1).trim();
    if (tokens[key] != null && stack.includes(key)) throw new Error(`Cyclic theme token ${key}`);
    if (tokens[key] == null && key.startsWith('--vscode-') && !/^(?:--vscode-(?:editor-)?font-)/.test(key) && !fallback.includes('var(') && !['transparent','inherit','currentColor'].includes(fallback)) missing.push(key);
    result += resolveVars(tokens[key] ?? fallback, tokens, tokens[key] != null ? [...stack,key] : stack, missing);
    i = end;
  }
  return result;
}
// Each audit run owns these caches. Keys use source/token values so edits and
// mutations cannot reuse stale results. Call disposeAudit when the run finishes.
const parsedSheets = new Map(), resolvedSheets = new Map(), measurements = new Map();
let documentDom, documentCss, documentBody;
export function disposeAudit() {
  documentDom?.window.close();
  documentDom = documentCss = documentBody = undefined;
  parsedSheets.clear();
  resolvedSheets.clear();
  measurements.clear();
}
function documentFor(css, body) {
  documentDom ??= new JSDOM('<head><style></style></head><body></body>');
  const { document } = documentDom.window;
  if (documentCss !== css) {
    document.querySelector('style').textContent = css;
    documentCss = css;
  }
  if (documentBody !== body) {
    document.body.innerHTML = body;
    documentBody = body;
  }
  return documentDom;
}
function resolvedSheet(css, injected) {
  const key = JSON.stringify([css, Object.entries(injected).sort(([a], [b]) => a.localeCompare(b))]);
  if (resolvedSheets.has(key)) return resolvedSheets.get(key);
  if (!parsedSheets.has(css)) parsedSheets.set(css, postcss.parse(css));
  // Only mutate a clone: each theme must start with the original declarations.
  const sheet = parsedSheets.get(css).clone();
  const tokens = {...injected}, missing = [], placeholderRules = [];
  sheet.walkRules((rule) => {
    if (rule.selector === ':root') rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) tokens[decl.prop] = decl.value;
    });
  });
  sheet.walkDecls((decl) => {
    // Audit unused declarations too, so a missing optional color cannot hide in
    // a component/state absent from the representative HTML fixtures.
    const value = resolveVars(decl.value,tokens,[],missing);
    if (!decl.prop.startsWith('--')) decl.value = value;
  });
  sheet.walkRules((rule) => {
    if (!rule.selector.includes('::placeholder')) return;
    rule.walkDecls('color', (decl) => placeholderRules.push({
      selector: rule.selector.replaceAll('::placeholder',''), color: decl.value
    }));
  });
  const result = { css: sheet.toString(), missing, placeholderRules };
  resolvedSheets.set(key, result);
  return result;
}
export function resolvedCss(css, injected, missing = []) {
  const result = resolvedSheet(css, injected);
  missing.push(...result.missing);
  return result.css;
}

function rgba(color) {
  if (color === 'transparent' || !color) return [0,0,0,0];
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length<=4) hex = [...hex].map((c)=>c+c).join('');
    return [0,2,4].map((i)=>parseInt(hex.slice(i,i+2),16)).concat(hex.length===8 ? parseInt(hex.slice(6),16)/255:1);
  }
  if (color.startsWith('color(srgb ')) {
    const parts = color.match(/[\d.]+/g).map(Number);
    return parts.slice(0,3).map((value) => value * 255).concat(parts[3] ?? 1);
  }
  const parts = color.match(/[\d.]+/g)?.map(Number);
  if (/^rgba?\(/.test(color) && parts?.length>=3) return [...parts.slice(0,3),parts[3]??1];
  throw new Error(`Unmeasured color: ${color}`);
}
function over(front,back) {
  const alpha = front[3]+back[3]*(1-front[3]);
  return front.slice(0,3).map((c,i)=>(c*front[3]+back[i]*back[3]*(1-front[3]))/alpha).concat(alpha);
}
function luminance(rgb) { return rgb.slice(0,3).map((v)=>v/255).map((v)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0); }
export function ratio(a,b) { const [x,y]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (x+.05)/(y+.05); }
export function measure(css,body,tokens,excluded = []) {
  // jsdom cannot resolve CSS custom properties. Resolve the actual production
  // root declarations first, then let its CSS cascade compute each fixture pair.
  // This is a static check, not evidence of a Chrome render or browser layout.
  const resolved = resolvedSheet(css,tokens);
  const fullCss = `body{background:${tokens['--vscode-editor-background']};color:${tokens['--vscode-foreground']}}${resolved.css}`;
  const key = JSON.stringify([fullCss,body]);
  if (measurements.has(key)) {
    const cached = structuredClone(measurements.get(key));
    excluded.push(...cached.excluded);
    return cached.records;
  }
  const dom = documentFor(fullCss,body);
  const {window}=dom;
  const records=[], exclusions=[];
  const styles = new WeakMap(), backgrounds = new WeakMap();
  const style=(el)=> {
    if (!styles.has(el)) styles.set(el,window.getComputedStyle(el));
    return styles.get(el);
  };
  function background(el) {
    if (!el) return rgba(tokens['--vscode-editor-background']);
    if (!backgrounds.has(el)) backgrounds.set(el,over(rgba(style(el).backgroundColor),background(el.parentElement)));
    return backgrounds.get(el);
  }
  const {placeholderRules} = resolved;
  for (const el of window.document.body.querySelectorAll('*')) {
    if (el.closest('[data-mode="designer"]')) continue; // authored page, not editor chrome
    if (el.matches('script,style,option')) continue;
    if (el.matches(':disabled') || el.closest('[aria-disabled="true"]')) {
      exclusions.push({selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(), reason: 'disabled control'});
      continue;
    }
    const text = [...el.childNodes].filter((n)=>n.nodeType===3).map((n)=>n.textContent).join('').trim() || (el.matches('input,textarea')?el.value:'');
    if (!text && !el.getAttribute('placeholder')) continue;
    let visible=true;
    for (let parent=el;parent;parent=parent.parentElement) {
      const s=style(parent);
      if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') visible=false;
      if (parent.matches('details:not([open])') && !el.closest('summary')) visible=false;
    }
    if (!visible) continue;
    const s=style(el), bg=background(el), fg=over(rgba(s.color),bg);
    const opacity = Number(s.opacity || 1);
    const actual = opacity === 1 ? fg : over([...fg.slice(0,3),opacity],bg);
    if (text) records.push({selector:el.id?`#${el.id}`:`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`,text:text.slice(0,70),foreground:actual.slice(0,3).map(Math.round),background:bg.slice(0,3).map(Math.round),ratio:ratio(actual,bg)});
    if (el.getAttribute('placeholder')) {
      const color = placeholderRules.filter((rule) => el.matches(rule.selector)).at(-1)?.color;
      if (!color) throw new Error('Placeholder fixture has no themed color');
      const probe = window.document.createElement('span');
      probe.style.color = color;
      el.parentElement.append(probe);
      const hint = over(rgba(style(probe).color),bg);
      records.push({selector: `${el.id ? '#'+el.id : el.tagName.toLowerCase()}::placeholder`, text: el.getAttribute('placeholder'), foreground: hint.slice(0,3).map(Math.round), background: bg.slice(0,3).map(Math.round), ratio: ratio(hint,bg), typedForeground: fg.slice(0,3).map(Math.round)});
      probe.remove();
    }
  }
  measurements.set(key,structuredClone({records,excluded:exclusions}));
  excluded.push(...exclusions);
  return records;
}

// Behavioral checks complement text contrast: hierarchy, semantic success hues,
// diff markers, and an interaction layer that cannot paint a grid over objects.
export function presentationFailures(css, body, tokens) {
  const failures = [];
  const dom = documentFor(resolvedCss(css,tokens),body);
  const style = (el) => dom.window.getComputedStyle(el);
  for (const surface of dom.window.document.querySelectorAll('.design-surface > [data-mode="designer"]')) {
    if (['', 'none'].includes(style(surface).backgroundImage)) failures.push('missing grid below objects');
  }
  for (const layer of dom.window.document.querySelectorAll('.interaction-layer')) {
    if (!['', 'none'].includes(style(layer).backgroundImage)) failures.push('grid over objects');
  }
  for (const success of dom.window.document.querySelectorAll('.status.success, .test-badge.success, .ok')) {
    const color = rgba(style(success).backgroundColor);
    if (!(color[1] > color[0] && color[1] > color[2])) failures.push('success background is not green');
  }
  for (const base of ['field-cell', 'tree-leaf']) {
    const unchanged = dom.window.document.querySelector(`.${base}.unchanged`);
    if (!unchanged) continue;
    for (const state of ['added', 'removed', 'changed']) {
      const cell = dom.window.document.querySelector(`.${base}.${state}`);
      if (!cell) continue;
      const marker = style(cell), normal = style(unchanged);
      if (marker.borderStyle === normal.borderStyle && marker.borderColor === normal.borderColor) failures.push(`${base} ${state} has no distinct marker`);
      // HC changed/unchanged can share the same border color. A line pattern
      // must still distinguish each state without the badge's text.
      if (state === 'changed' && marker.borderStyle === normal.borderStyle) failures.push(`${base} changed has no line pattern`);
      const border = rgba(marker.borderColor);
      const bg = rgba(tokens['--vscode-editor-background']);
      if (tokens['--vscode-contrastBorder'] && ratio(over(border,bg),bg) < 3) failures.push(`${base} ${state} marker contrast`);
    }
  }
  // Placeholder presence depends on the fixture, not the theme. Other fixtures
  // need the presentation checks above, but no second text-contrast measurement.
  const pairs = dom.window.document.querySelector('[placeholder]') ? measure(css,body,tokens) : [];
  for (const pair of pairs.filter((pair) => pair.selector.endsWith('::placeholder'))) {
    if (pair.foreground.join() === pair.typedForeground.join()) failures.push('placeholder matches typed text');
  }
  if (/--muted\s*:/.test(css)) {
    const primary = measure(css+'.audit-primary { color:var(--text, var(--ink, var(--vscode-foreground))); } .audit-muted { color:var(--muted); }','<section class="panel form-section pane"><span class="audit-primary">Primary</span><span class="audit-muted">Secondary</span></section>',tokens);
    if (primary.length !== 2 || primary[0].ratio < primary[1].ratio * 1.1 || primary[1].ratio < 4.5) failures.push('secondary hierarchy or contrast');
  }
  return failures;
}
