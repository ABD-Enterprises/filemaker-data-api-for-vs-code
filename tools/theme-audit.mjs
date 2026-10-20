// Offline theme fixtures, contrast audit and strictly headless Chrome screenshots.
// Usage: node tools/theme-audit.mjs [output-directory]
// No server, browser automation connection, downloads, or extension host is used.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import postcss from 'postcss';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'artifacts/theme-audit'));
mkdirSync(output, { recursive: true });
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const require = createRequire(import.meta.url);
const { createBlankLayout } = require('@fmweb/shared');
const themeDirectory = process.env.VSCODE_THEME_DIRECTORY ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-defaults/themes';
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const workbenchPath = path.resolve(themeDirectory, '../../../out/vs/workbench/workbench.desktop.main.js');
// These inherited color registrations were read from the installed VS Code bundle,
// not inferred from theme JSON (Light+/Dark+/HC omit most UI tokens). Null tokens
// are intentionally absent so production fallbacks are exercised. Alpha is retained.
const defaults = {
  light: { foreground:'#616161', descriptionForeground:'#717171', 'editorWidget.background':'#f3f3f3', 'input.background':'#ffffff', 'button.background':'#007acc', 'button.hoverBackground':'#0062a3', 'list.hoverBackground':'#f0f0f0', 'button.secondaryBackground':'#f0f0f0', 'button.secondaryHoverBackground':'#ffffff', focusBorder:'#0090f1', errorForeground:'#a1260d', 'textLink.foreground':'#006ab1', 'diffEditor.insertedTextBackground':'#9ccc2c40', 'diffEditor.removedTextBackground':'#ff000033', 'inputValidation.infoBackground':'#d6ecf2', 'inputValidation.warningBackground':'#f6f5d2', 'inputValidation.errorBackground':'#f2dede', 'editorWarning.foreground':'#bf8803', 'textCodeBlock.background':'#dcdcdc66', 'sideBar.background':'#f3f3f3', 'textBlockQuote.background':'#7f7f7f1a' },
  dark: { foreground:'#cccccc', descriptionForeground:'#ccccccb3', 'editorWidget.background':'#252526', 'input.background':'#3c3c3c', 'button.background':'#0e639c', 'button.hoverBackground':'#1177bb', 'list.hoverBackground':'#2a2d2e', 'button.secondaryBackground':'#2a2d2e', 'button.secondaryHoverBackground':'#323637', focusBorder:'#007fd4', errorForeground:'#f48771', 'textLink.foreground':'#3794ff', 'diffEditor.insertedTextBackground':'#9ccc2c33', 'diffEditor.removedTextBackground':'#ff000033', 'inputValidation.infoBackground':'#063b49', 'inputValidation.warningBackground':'#352a05', 'inputValidation.errorBackground':'#5a1d1d', 'editorWarning.foreground':'#cca700', 'textCodeBlock.background':'#0a0a0a66', 'sideBar.background':'#252526', 'textBlockQuote.background':'#7f7f7f1a' },
  'high-contrast': { foreground:'#ffffff', descriptionForeground:'#ffffffb3', 'editorWidget.background':'#0c141f', 'input.background':'#000000', 'button.background':'#000000', 'button.hoverBackground':'#000000', 'list.hoverBackground':'#ffffff1a', focusBorder:'#f38518', contrastBorder:'#6fc3df', contrastActiveBorder:'#f38518', errorForeground:'#f48771', 'textLink.foreground':'#21a6ff', 'inputValidation.infoBackground':'#000000', 'inputValidation.warningBackground':'#000000', 'inputValidation.errorBackground':'#000000', 'editorWarning.foreground':'#ffd370', 'textCodeBlock.background':'#000000', 'sideBar.background':'#000000', 'textBlockQuote.background':'#000000' }
};
const installed = readFileSync(workbenchPath, 'utf8');
const sourceKeys = [...new Set(Object.values(defaults).flatMap((theme)=>Object.keys(theme)))];
const registrations = Object.fromEntries(sourceKeys.map((key)=>{
  const index = installed.indexOf(`le("${key}"`);
  return [key,index<0?'Theme override or inherited registration':installed.slice(index,index+320)];
}));
writeFileSync(path.join(output,'theme-sources.json'),JSON.stringify({
  version:JSON.parse(readFileSync(path.resolve(themeDirectory,'../../../package.json'),'utf8')).version,
  themeDirectory, workbenchPath, workbenchSha256:createHash('sha256').update(installed).digest('hex'),
  registrations, caveat:'JSON overrides plus inherited UI registrations from this local installation. Null optional tokens are omitted.'
},null,2)+'\n');
function themeFile(name) {
  const file = path.join(themeDirectory, name);
  const theme = JSON.parse(readFileSync(file, 'utf8'));
  return { ...(theme.include ? themeFile(theme.include) : {}), ...theme.colors };
}
function tokensFor(name, filename) {
  const values = { ...defaults[name], ...themeFile(filename) };
  Object.assign(values, {
    'button.foreground':'#ffffff', 'button.secondaryForeground':values.foreground,
    'input.foreground':values.foreground, 'editorWidget.foreground':values.foreground,
    'panel.border':values.contrastBorder ?? '#80808059',
    'testing.iconPassed':'#73c991',
    'progressBar.background':values.contrastBorder ?? '#0e70c0',
    'widget.shadow':name==='light'?'#00000029':name==='dark'?'#0000005c':'#000000',
    'disabledForeground':name==='light'?'#61616180':name==='dark'?'#cccccc80':'#a5a5a5',
    'inputOption.activeBackground':name==='light'?'#0090f133':name==='dark'?'#007fd466':'#00000000',
    'inputValidation.infoBorder':values.contrastBorder ?? '#007acc',
    'inputValidation.warningBorder':values.contrastBorder ?? '#b89500',
    'inputValidation.errorBorder':values.contrastBorder ?? '#be1100',
    'textBlockQuote.border':values.contrastBorder ?? '#007acc'
  });
  if (name==='high-contrast') {
    values['diffEditor.insertedTextBorder']='#33ff2eff';
    values['diffEditor.removedTextBorder']='#ff008f';
  } else {
    values['list.activeSelectionBackground']=name==='light'?'#0060c0':'#04395e';
    values['list.activeSelectionForeground']='#ffffff';
    values['menu.background']??=name==='light'?'#ffffff':'#3c3c3c';
    values['menu.foreground']??=name==='light'?values.foreground:'#f0f0f0';
    values['menu.selectionBackground']??=values['list.activeSelectionBackground'];
    values['menu.selectionForeground']??='#ffffff';
  }
  return Object.fromEntries(Object.entries(values).filter(([,v]) => v != null).map(([k,v]) => [`--vscode-${k.replaceAll('.', '-')}`,v]));
}
function resolveVars(value, tokens, stack = []) {
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
    if (tokens[key] !== undefined && stack.includes(key)) throw new Error(`Cyclic theme token ${key}`);
    result += resolveVars(tokens[key] ?? fallback, tokens, tokens[key] !== undefined ? [...stack,key] : stack);
    i = end;
  }
  return result;
}
function resolvedCss(css, injected) {
  const sheet = postcss.parse(css);
  const tokens = {...injected};
  sheet.walkRules((rule) => {
    if (rule.selector === ':root') rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) tokens[decl.prop] = decl.value;
    });
  });
  sheet.walkDecls((decl) => { if (!decl.prop.startsWith('--')) decl.value = resolveVars(decl.value,tokens); });
  return sheet.toString();
}
const standards = buildSync({ entryPoints:[path.join(root,'shared/src/field-standards.ts')],bundle:true,platform:'node',format:'cjs',write:false }).outputFiles[0].text;
const standardModule = { exports:{} };
new Function('module',standards)(standardModule);
const standardsCss = standardModule.exports.standardFieldsCss();
const basicField = '<table class="fm-field-table"><tbody class="fm-fields"><tr class="fm-field" data-fm-width="240" data-fm-height="34"><td class="fm-field-label">Customer name</td><td><textarea class="fm-field-control">Ada Lovelace</textarea></td></tr></tbody></table>';
function webview(page) {
  const source = read(`extension/src/webviews/${page}/index.ts`);
  let body = /<body>([\s\S]*?)<\/body>/.exec(source)[1].replace(/<script[\s\S]*?<\/script>/g,'').replace(/\$\{[^}]*\}/g,'');
  const dom = new JSDOM(body);
  const doc = dom.window.document;
  for (const select of doc.querySelectorAll('select')) select.innerHTML = '<option>Customers</option>';
  for (const input of doc.querySelectorAll('input[type=text]')) input.value = '1';
  for (const pre of doc.querySelectorAll('pre')) pre.textContent = '{ "Name": "Ada Lovelace" }';
  for (const field of doc.querySelectorAll('#fieldDataContainer, #fieldEditor')) field.innerHTML = basicField;
  for (const status of doc.querySelectorAll('.status')) status.textContent ||= 'Ready';
  doc.body.insertAdjacentHTML('beforeend','<section class="panel"><p class="status error">Example error: connection refused</p><a href="#">Help</a><button class="secondary">Secondary</button><details class="menu" open><summary>Copy request</summary><div class="menu-items"><button>Copy as curl</button></div></details></section><footer class="fm-version">FileMaker Data API Tools v1.6.0</footer>');
  if (page === 'recordEditor') {
    doc.querySelector('#conflictBanner').classList.remove('hidden');
    doc.querySelector('#conflictText').textContent = 'Record changed on the server.';
  }
  if (page === 'scriptRunner') {
    doc.querySelector('#parameterBuilderPanel').classList.remove('hidden');
    doc.querySelector('#parameterRows').innerHTML = '<div class="builder-row"><label>Key<input value="name"></label><select><option>Text</option></select><textarea>Example</textarea><button>Remove</button></div>';
  }
  if (page === 'schemaDiff') {
    doc.body.insertAdjacentHTML('beforeend','<section><div class="side-by-side-grid">'+['added','removed','changed','unchanged'].map((status)=>`<div class="field-cell ${status}"><span class="status-badge ${status}">${status}</span><div class="field-title">Customer</div><dl class="field-meta"><dt>Type</dt><dd>Text</dd></dl></div>`).join('')+'</div></section>');
  }
  if (page === 'connectionWizard') doc.body.insertAdjacentHTML('beforeend','<section><span class="test-badge success">Passed</span><span class="test-badge failure">Failed</span><span class="test-badge stale">Stale</span><p class="warning-hint">Warning: legacy TLS</p><p class="status error">Error</p><p class="status warning">Warning</p><p class="status success">Success</p></section>');
  const result = { body:doc.body.innerHTML, css:read(`extension/src/webviews/${page}/ui/styles.css`)+standardsCss };
  dom.window.close();
  return result;
}
async function designer() {
  const helper = buildSync({entryPoints:[path.join(root,'designer-ui/src/canvas-engine.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
  const module = {exports:{}};
  new Function('module',helper)(module);
  const fields = [{name:'Name',type:'text'},{name:'Amount',type:'number'},{name:'Notes',type:'long text'}];
  const layout = module.exports.createStarterTemplate(createBlankLayout('Theme sample','Customers'),fields,'twoColumn',fields.map((_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`));
  const dom = new JSDOM('<div id="root"></div>',{runScripts:'outside-only',pretendToBeVisual:true});
  dom.window.eval(read('designer-ui/dist/index.js'));
  await new Promise((r)=>setTimeout(r,80));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:{type:'init',payload:{layout,availableFields:fields.map((f)=>f.name),availableFieldMetadata:fields,scripts:[],projectName:'Theme audit'}}}));
  await new Promise((r)=>setTimeout(r,80));
  const first = dom.window.document.querySelector('.object-hitbox');
  first?.dispatchEvent(new dom.window.MouseEvent('mousedown',{bubbles:true,button:0}));
  dom.window.dispatchEvent(new dom.window.MouseEvent('mouseup',{bubbles:true}));
  await new Promise((r)=>setTimeout(r,30));
  const result = {body:dom.window.document.body.innerHTML,css:read('designer-ui/src/styles.css')};
  dom.window.close();
  return result;
}
function inline(file, body) {
  const css = /<style\b[^>]*>([\s\S]*?)<\/style>/.exec(read(file))[1];
  return {css,body};
}
const pages = Object.fromEntries(['recordViewer','recordEditor','scriptRunner','schemaDiff','queryBuilder','connectionWizard'].map((page)=>[page,webview(page)]));
pages.designer = await designer();
pages.layoutFallback = {css:read('extension/src/webviews/layoutMode/ui/index.css'),body:'<div id="root">Loading Layout Mode</div><footer class="fm-version">FileMaker v1.6.0</footer>'};
pages.environmentCompare = inline('extension/src/webviews/environmentCompare/index.ts','<div class="container"><section class="card"><h1>Environment comparison</h1><table><tr><th>Environment</th><th>Status</th></tr><tr><td>Staging</td><td><span class="ok">OK</span><span class="warn">Warning</span><span class="bad">Failed</span></td></tr></table></section></div><footer class="fm-version">FileMaker v1.6.0</footer>');
pages.diagnostics = inline('extension/src/diagnostics/diagnosticsDashboard.ts','<div class="container"><section class="card"><h1>Diagnostics</h1><div class="stat"><p class="label">Requests</p><p>42</p></div><button>Refresh</button><p class="muted">No errors</p><table><tr><th>Profile</th></tr><tr><td>Customers</td></tr></table></section></div><footer class="fm-version">FileMaker v1.6.0</footer>');
pages.effectiveSettings = inline('extension/src/settings/effectiveSettings.ts','<h2>Effective settings</h2><p class="muted">Current settings</p><p class="ignored">Workspace setting ignored</p><table><tr><th>Setting</th><th>Value</th></tr><tr><td>Connection</td><td>Active</td></tr></table>');
function rgba(color) {
  if (color === 'transparent' || !color) return [0,0,0,0];
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length<=4) hex = [...hex].map((c)=>c+c).join('');
    return [0,2,4].map((i)=>parseInt(hex.slice(i,i+2),16)).concat(hex.length===8 ? parseInt(hex.slice(6),16)/255:1);
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
function ratio(a,b) { const [x,y]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (x+.05)/(y+.05); }
function measure(css,body,tokens) {
  // jsdom cannot resolve CSS custom properties. Resolve the actual production
  // root declarations first, then let its CSS cascade compute each fixture pair.
  // This is a static check, not evidence of a Chrome render or browser layout.
  const dom = new JSDOM(`<style>body{background:${tokens['--vscode-editor-background']};color:${tokens['--vscode-foreground']}}${resolvedCss(css,tokens)}</style>${body}`);
  const {window}=dom;
  const records=[];
  const style=(el)=>window.getComputedStyle(el);
  function background(el) {
    if (!el) return rgba(tokens['--vscode-editor-background']);
    return over(rgba(style(el).backgroundColor),background(el.parentElement));
  }
  for (const el of window.document.body.querySelectorAll('*')) {
    if (el.closest('[data-mode="designer"]')) continue; // authored page, not editor chrome
    if (el.matches('script,style,option') || el.disabled) continue;
    const text = [...el.childNodes].filter((n)=>n.nodeType===3).map((n)=>n.textContent).join('').trim() || (el.matches('input,textarea')?el.value:'');
    if (!text) continue;
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
    records.push({selector:el.id?`#${el.id}`:`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`,text:text.slice(0,70),foreground:actual.slice(0,3).map(Math.round),background:bg.slice(0,3).map(Math.round),ratio:ratio(actual,bg)});
  }
  dom.window.close();
  return records;
}
const rows=[],details={},screenshots=[];
for (const [theme,filename] of [['light','light_plus.json'],['dark','dark_plus.json'],['high-contrast','hc_black.json']]) {
  const tokens = tokensFor(theme,filename);
  writeFileSync(path.join(output,`${theme}-tokens.json`),JSON.stringify(tokens,null,2)+'\n');
  for (const [page,{body,css}] of Object.entries(pages)) {
    const file=path.join(output,`${page}-${theme}.html`);
    writeFileSync(file,`<!doctype html><html><head><meta charset="utf-8"><title>${page} ${theme}</title><style>:root{${Object.entries(tokens).map(([k,v])=>`${k}:${v}`).join(';')}}body{background:var(--vscode-editor-background);color:var(--vscode-foreground)}${css}</style></head><body class="vscode-${theme==='high-contrast'?'high-contrast':theme}">${body}</body></html>`);
    for (const state of ['normal','hover','focus']) {
      // :focus-visible and :hover have color-only rules; emulate the state in
      // static CSS so no UI interaction is needed in this fallback measurement.
      const stateCss = state==='normal'?css:css.replaceAll(state==='hover'?':hover':':focus-visible',':not(.audit-never)');
      const pairs=measure(stateCss,body,tokens), failures=pairs.filter((p)=>p.ratio<4.5);
      const key=`${page}/${theme}/${state}`;
      details[key]=pairs;
      rows.push({page,theme,state,pairs:pairs.length,minimum:Math.min(...pairs.map((p)=>p.ratio)),failures:failures.length});
    }
  }
  // One screenshot attempt per theme. An abort proves no render; don't generate
  // substitute images. On a working host the fixtures can all be captured below.
  const target=path.join(output,`designer-${theme}.png`);
  const args=['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',`--user-data-dir=${path.join(output,`chrome-${theme}`)}`,'--window-size=1440,1000','--virtual-time-budget=1000',`--screenshot=${target}`,pathToFileURL(path.join(output,`designer-${theme}.html`)).href];
  const attempt=spawnSync(chrome,args,{encoding:'utf8',timeout:20000});
  screenshots.push({theme,args,status:attempt.status,signal:attempt.signal,error:attempt.error?.message,screenshot:existsSync(target)?target:null});
  writeFileSync(path.join(output,`chrome-${theme}.log`),(attempt.stdout??'')+(attempt.stderr??''));
  if (existsSync(target)) {
    for (const page of Object.keys(pages).filter((name)=>name!=='designer')) {
      const next=path.join(output,`${page}-${theme}.png`);
      const run=spawnSync(chrome,args.map((arg)=>arg===`--screenshot=${target}`?`--screenshot=${next}`:arg===args.at(-1)?pathToFileURL(path.join(output,`${page}-${theme}.html`)).href:arg),{encoding:'utf8',timeout:20000});
      screenshots.push({page,theme,status:run.status,signal:run.signal,screenshot:existsSync(next)?next:null});
    }
  }
}
writeFileSync(path.join(output,'contrast-pairs.json'),JSON.stringify(details,null,2)+'\n');
writeFileSync(path.join(output,'screenshots.json'),JSON.stringify(screenshots,null,2)+'\n');
writeFileSync(path.join(output,'contrast.csv'),'page,theme,state,pairs,minimum,failures\n'+rows.map((r)=>[r.page,r.theme,r.state,r.pairs,r.minimum.toFixed(3),r.failures].join(',')).join('\n')+'\n');
writeFileSync(path.join(output,'contrast.md'),'Static CSS contrast (jsdom after token substitution; NOT a browser render). Minimum 4.5:1, including small text.\n\n| Page | Theme | State | Pairs | Minimum | Failures |\n| --- | --- | --- | ---: | ---: | ---: |\n'+rows.map((r)=>`| ${r.page} | ${r.theme} | ${r.state} | ${r.pairs} | ${r.minimum.toFixed(3)} | ${r.failures} |`).join('\n')+'\n');
console.log(JSON.stringify({output,rows:rows.length,failures:rows.reduce((n,r)=>n+r.failures,0),screenshots:screenshots.filter((s)=>s.screenshot).length,themeDirectory,workbenchPath},null,2));
if (rows.some((r)=>r.failures||!r.pairs) || screenshots.some((s)=>!s.screenshot)) process.exitCode=1;
