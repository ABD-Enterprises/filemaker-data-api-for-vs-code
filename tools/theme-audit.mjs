// Offline theme fixtures, contrast audit and strictly headless Chrome screenshots.
// Usage: node tools/theme-audit.mjs [output-directory] [--static]
// No server, browser automation connection, downloads, or extension host is used.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import { themes, registrations, tokensFor, resolvedCss, measure, presentationFailures } from './theme-audit-colors.mjs';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticOnly = process.argv.includes('--static');
const output = path.resolve(process.argv.slice(2).find((arg)=>arg !== '--static') ?? path.join(root, 'artifacts/theme-audit'));
mkdirSync(output, { recursive: true });
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const require = createRequire(import.meta.url);
const { createBlankLayout } = require('@fmweb/shared');
const themeDirectory = process.env.VSCODE_THEME_DIRECTORY ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-defaults/themes';
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const workbenchPath = path.resolve(themeDirectory, '../../../out/vs/workbench/workbench.desktop.main.js');
// Record the installed registrations alongside the explicit offline snapshot.
const installed = readFileSync(workbenchPath, 'utf8');
const sources = Object.fromEntries(Object.keys(registrations).map((key) => {
  const index = installed.indexOf(`le("${key}"`);
  if (index < 0) throw new Error(`Missing source registration ${key}`);
  return [key, installed.slice(index, index + 400)];
}));
writeFileSync(path.join(output,'theme-sources.json'), JSON.stringify({
  version: JSON.parse(readFileSync(path.resolve(themeDirectory,'../../../package.json'),'utf8')).version,
  themeDirectory, workbenchPath, workbenchSha256: createHash('sha256').update(installed).digest('hex'),
  sources, registrations, caveat: 'VS Code 1.142 registration snapshot plus installed JSON overrides. Null properties are absent.'
},null,2)+'\n');
function themeFile(name) {
  const theme = JSON.parse(readFileSync(path.join(themeDirectory, name), 'utf8'));
  return { ...(theme.include ? themeFile(theme.include) : {}), ...theme.colors };
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
  doc.body.insertAdjacentHTML('beforeend','<section class="panel"><input id="audit-placeholder" placeholder="Example hint" value="Typed text"><textarea placeholder="Example hint">Typed text</textarea><button id="audit-disabled" disabled>Disabled (excluded)</button><p class="status error">Example error: connection refused</p><a href="#">Help</a><button class="secondary">Secondary</button><details class="menu" open><summary>Copy request</summary><div class="menu-items"><button>Copy as curl</button></div></details></section><footer class="fm-version">FileMaker Data API Tools v1.6.0</footer>');
  if (page === 'recordEditor') {
    doc.querySelector('#conflictBanner').classList.remove('hidden');
    doc.querySelector('#conflictText').textContent = 'Record changed on the server.';
  }
  if (page === 'scriptRunner') {
    doc.querySelector('#parameterBuilderPanel').classList.remove('hidden');
    doc.querySelector('#parameterRows').innerHTML = '<div class="builder-row"><label>Key<input value="name"></label><select><option>Text</option></select><textarea>Example</textarea><button>Remove</button></div>';
  }
  if (page === 'schemaDiff') {
    doc.body.insertAdjacentHTML('beforeend','<section>'+['field-cell','tree-leaf'].map((base)=>'<div class="side-by-side-grid">'+['added','removed','changed','unchanged'].map((status)=>`<div class="${base} ${status}"><span class="status-badge ${status}">${status}</span><div class="field-title">Customer</div>${base==='field-cell'?'<dl class="field-meta"><dt>Type</dt><dd>Text</dd></dl>':'<span class="tree-field-type">Text</span><ul class="change-list"><li>Type changed</li></ul>'}</div>`).join('')+'</div>').join('')+'</section>');
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
pages.designer.body += '<section class="pane"><input placeholder="Example hint" value="Typed text"><button id="designer-disabled" disabled>Disabled (excluded)</button></section>';
pages.layoutFallback = {css:read('extension/src/webviews/layoutMode/ui/index.css'),body:'<div id="root">Loading Layout Mode</div><footer class="fm-version">FileMaker v1.6.0</footer>'};
pages.environmentCompare = inline('extension/src/webviews/environmentCompare/index.ts','<div class="container"><section class="card"><h1>Environment comparison</h1><table><tr><th>Environment</th><th>Status</th></tr><tr><td>Staging</td><td><span class="ok">OK</span><span class="warn">Warning</span><span class="bad">Failed</span></td></tr></table></section></div><footer class="fm-version">FileMaker v1.6.0</footer>');
pages.diagnostics = inline('extension/src/diagnostics/diagnosticsDashboard.ts','<div class="container"><section class="card"><h1>Diagnostics</h1><div class="stat"><p class="label">Requests</p><p>42</p></div><button>Refresh</button><p class="muted">No errors</p><table><tr><th>Profile</th></tr><tr><td>Customers</td></tr></table></section></div><footer class="fm-version">FileMaker v1.6.0</footer>');
pages.effectiveSettings = inline('extension/src/settings/effectiveSettings.ts','<h2>Effective settings</h2><p class="muted">Current settings</p><p class="ignored">Workspace setting ignored</p><table><tr><th>Setting</th><th>Value</th></tr><tr><td>Connection</td><td>Active</td></tr></table>');
const rows=[],details={},screenshots=[],excluded={},guardFailures=[];
for (const [theme,filename] of themes) {
  const tokens = tokensFor(theme,themeFile(filename));
  writeFileSync(path.join(output,`${theme}-tokens.json`),JSON.stringify(tokens,null,2)+'\n');
  for (const [page,{body,css}] of Object.entries(pages)) {
    const missing=[];
    resolvedCss(css,tokens,missing);
    guardFailures.push(...[...new Set(missing)].map((key)=>`${page}/${theme}: undefined token reaches literal: ${key}`));
    guardFailures.push(...presentationFailures(css,body,tokens).map((failure)=>`${page}/${theme}: ${failure}`));
    const file=path.join(output,`${page}-${theme}.html`);
    writeFileSync(file,`<!doctype html><html><head><meta charset="utf-8"><title>${page} ${theme}</title><style>:root{${Object.entries(tokens).map(([k,v])=>`${k}:${v}`).join(';')}}body{background:var(--vscode-editor-background);color:var(--vscode-foreground)}${css}</style></head><body class="vscode-${theme}">${body}</body></html>`);
    for (const state of ['normal','hover','focus']) {
      // :focus-visible and :hover have color-only rules; emulate the state in
      // static CSS so no UI interaction is needed in this fallback measurement.
      const stateCss = state==='normal'?css:css.replaceAll(state==='hover'?':hover':':focus-visible',':not(.audit-never)');
      const exclusions=[];
      const pairs=measure(stateCss,body,tokens,exclusions), failures=pairs.filter((p)=>p.ratio<4.5);
      excluded[`${page}/${theme}/${state}`]=exclusions;
      const key=`${page}/${theme}/${state}`;
      details[key]=pairs;
      rows.push({page,theme,state,pairs:pairs.length,minimum:Math.min(...pairs.map((p)=>p.ratio)),failures:failures.length});
    }
  }
  if (staticOnly) continue;
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
writeFileSync(path.join(output,'disabled-controls.json'),JSON.stringify(excluded,null,2)+'\n');
writeFileSync(path.join(output,'guard-failures.json'),JSON.stringify(guardFailures,null,2)+'\n');
writeFileSync(path.join(output,'contrast-pairs.json'),JSON.stringify(details,null,2)+'\n');
writeFileSync(path.join(output,'screenshots.json'),JSON.stringify(screenshots,null,2)+'\n');
writeFileSync(path.join(output,'contrast.csv'),'page,theme,state,pairs,minimum,failures\n'+rows.map((r)=>[r.page,r.theme,r.state,r.pairs,r.minimum.toFixed(3),r.failures].join(',')).join('\n')+'\n');
writeFileSync(path.join(output,'contrast.md'),'Static CSS contrast (jsdom after token substitution; NOT a browser render). Minimum 4.5:1, including small text.\n\n| Page | Theme | State | Pairs | Minimum | Failures |\n| --- | --- | --- | ---: | ---: | ---: |\n'+rows.map((r)=>`| ${r.page} | ${r.theme} | ${r.state} | ${r.pairs} | ${r.minimum.toFixed(3)} | ${r.failures} |`).join('\n')+'\n\nDisabled controls excluded (full per-state list: disabled-controls.json):\n'+[...new Set(Object.entries(excluded).flatMap(([key,items])=>items.map((item)=>`- ${key.split('/')[0]} ${item.selector}: ${item.reason}`)))].join('\n')+'\n');
console.log(JSON.stringify({output,staticOnly,rows:rows.length,failures:rows.reduce((n,r)=>n+r.failures,0),guardFailures,screenshots:screenshots.filter((s)=>s.screenshot).length,themeDirectory,workbenchPath},null,2));
if (guardFailures.length || rows.some((r)=>r.failures||!r.pairs) || screenshots.some((s)=>!s.screenshot)) process.exitCode=1;
