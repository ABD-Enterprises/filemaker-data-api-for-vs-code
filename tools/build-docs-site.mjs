#!/usr/bin/env node
// Offline documentation build. The Markdown files remain the source of truth.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const repository = 'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code';
const marketplace = 'https://marketplace.visualstudio.com/items?itemName=SureForgeTech.filemaker-data-api-tools';
const website = 'https://sureforgetech.github.io/filemaker-data-api-for-vs-code/';
const markdown = new MarkdownIt({ html: false });
const escape = markdown.utils.escapeHtml;
const posix = (value) => value.split(path.sep).join('/');
const encodePath = (value) => posix(value).split('/').map(encodeURIComponent).join('/');
const relative = (from, to) => encodePath(path.relative(path.dirname(from), to)) + (to.endsWith('/') ? '/' : '');
const slug = (text) => /^\d+\.\d+\.\d+$/.test(text) ? text.replaceAll('.', '-') : text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
const plain = (tokens) => tokens.map((token) => token.children ? plain(token.children) : ['text', 'code_inline'].includes(token.type) ? token.content : '').join('');
const stylesheet = `
:root{color-scheme:light dark;--bg:#fff;--fg:#20252b;--muted:#4c5764;--link:#0756a4;--panel:#f1f4f7;--border:#c5ced8}
@media(prefers-color-scheme:dark){:root{--bg:#141a21;--fg:#e4eaf1;--muted:#bac6d3;--link:#89c5ff;--panel:#202a36;--border:#536071}}
*{box-sizing:border-box}html{scroll-behavior:auto}body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.65 system-ui,sans-serif;overflow-wrap:anywhere}
header,main,footer{max-width:72rem;margin:auto;padding:1.25rem clamp(1rem,4vw,3rem)}header,footer{border-block-end:1px solid var(--border)}footer{border-block-start:1px solid var(--border);border-block-end:0;color:var(--muted)}
a{color:var(--link);text-underline-offset:.15em}a:hover{text-decoration-thickness:.15em}:focus-visible{outline:3px solid var(--link);outline-offset:3px}.brand{font-weight:700;font-size:1.2rem}nav ul{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;list-style:none;padding:0}nav[aria-label="On this page"] ul{display:block;columns:2;column-gap:2rem}nav[aria-label="On this page"] li{break-inside:avoid;margin-block:.3rem}
h1,h2,h3,h4{line-height:1.25;scroll-margin-top:1rem}h1{font-size:clamp(1.7rem,5vw,2.5rem)}h2{margin-top:2.5rem}h3{margin-top:2rem}p,li{max-width:85ch}img{max-width:100%;height:auto}pre{max-width:100%;overflow-x:auto;padding:1rem;background:var(--panel);border:1px solid var(--border);border-radius:.4rem;overflow-wrap:normal}code{font-size:.9em}blockquote{margin-inline:0;padding-inline:1rem;border-inline-start:4px solid var(--border);color:var(--muted)}
.table-scroll{max-width:100%;overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.95rem}th,td{min-width:8rem;text-align:start;vertical-align:top;border:1px solid var(--border);padding:.6rem}td code,th code{white-space:nowrap;overflow-wrap:normal;word-break:normal}th{background:var(--panel)}.toc{padding:1rem;background:var(--panel);border-radius:.4rem}.toc h2{margin-top:0;font-size:1.2rem}.skip-link{position:absolute;left:1rem;top:-5rem;padding:.6rem;background:var(--bg);z-index:1}.skip-link:focus{top:1rem}
@media(max-width:600px){nav[aria-label="On this page"] ul{columns:1}header,main,footer{padding:1rem}ul,ol{padding-inline-start:1.4rem}}
`;
markdown.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0" role="region" aria-label="Table"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

function parse(source) {
  const tokens = markdown.parse(source, {});
  const headings = [];
  const used = new Set(['main']);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const title = plain(tokens[i + 1].children ?? []);
    const base = slug(title) || 'section';
    let id = base;
    let n = 0;
    while (used.has(id)) id = `${base}-${++n}`;
    used.add(id);
    tokens[i].attrSet('id', id);
    headings.push({ id, title, level: Number(tokens[i].tag.slice(1)) });
  }
  return { tokens, headings };
}

function releasedChangelog(source) {
  const sections = [...source.matchAll(/^## (.+)\r?$/gm)];
  const releases = sections.flatMap((match, i) => /^\d+\.\d+\.\d+$/.test(match[1])
    ? [{ version: match[1], source: source.slice(match.index, sections[i + 1]?.index ?? source.length) }] : []);
  releases.sort((a, b) => {
    const left = a.version.split('.').map(Number);
    const right = b.version.split('.').map(Number);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
  });
  if (!releases.length) throw new Error('No released versions in extension/CHANGELOG.md');
  return releases;
}

export function buildDocsSite({ root = fileURLToPath(new URL('../', import.meta.url)), out = 'pages' } = {}) {
  root = realpathSync(root);
  out = path.resolve(out);
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const version = JSON.parse(read('extension/package.json')).version;
  const releases = releasedChangelog(read('extension/CHANGELOG.md'));
  const current = releases.find((release) => release.version === version);
  if (!current) throw new Error(`Version ${version} is missing from extension/CHANGELOG.md`);
  const definitions = [
    ['extension/docs/USER_GUIDE.md', 'guide/index.html', 'User Guide'],
    ['extension/UPGRADE.md', 'upgrade/index.html', 'Upgrade notes'],
    ['extension/CHANGELOG.md', 'changelog/index.html', 'Changelog'],
    ['extension/docs/COMPATIBILITY.md', 'guide/compatibility/index.html', 'Compatibility'],
    ['extension/docs/FM_WEB.md', 'guide/fm-web/index.html', 'FM Web'],
    ...readdirSync(path.join(root, 'extension/docs/walkthroughs')).filter((file) => file.endsWith('.md')).sort()
      .map((file) => [`extension/docs/walkthroughs/${file}`, `guide/walkthroughs/${file.slice(0, -3)}/index.html`, null])
  ];
  const pages = new Map(definitions.map(([file, destination, title]) => {
    const parsed = parse(file === 'extension/CHANGELOG.md' ? `# Changelog\n\n${releases.map((r) => r.source).join('\n')}` : read(file));
    return [file, { file, destination, title: title ?? parsed.headings[0]?.title ?? file, ...parsed }];
  }));
  const write = (file, contents) => {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), contents);
  };
  const checkedFile = (file, label) => {
    const absolute = path.resolve(root, file);
    const inside = (target) => target.startsWith(`${root}${path.sep}`);
    if (!inside(absolute) || !existsSync(absolute) || !inside(realpathSync(absolute)) || !statSync(absolute).isFile()) {
      throw new Error(`${label}: ${file}`);
    }
    return absolute;
  };
  const copyImage = (file) => {
    const source = checkedFile(file, 'Missing image');
    if (!/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(file)) throw new Error(`Unsupported image: ${file}`);
    const destination = `assets/${posix(file)}`;
    mkdirSync(path.dirname(path.join(out, destination)), { recursive: true });
    copyFileSync(source, path.join(out, destination));
    return destination;
  };
  function rewrite(url, page, image = false) {
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(url)) {
      if (image) throw new Error(`Images must be local: ${page.file}: ${url}`);
      const prefix = `${repository}/blob/main/`;
      if (url.startsWith(prefix)) {
        const local = /^([^?#]*)(.*)$/.exec(url.slice(prefix.length));
        const file = decodeURIComponent(local[1]);
        if (pages.has(file)) {
          return rewrite(relative(page.file, file) + local[2], page);
        }
      }
      if (url === repository || url.startsWith(`${repository}/`) || url === marketplace || url.startsWith(website)) return url;
      throw new Error(`Unsupported external link: ${page.file}: ${url}`);
    }
    const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
    if (!match) throw new Error(`Broken internal link: ${page.file}: ${url}`);
    const [, pathname, query = '', hash = ''] = match;
    const file = pathname ? posix(path.relative(root, path.resolve(root, path.dirname(page.file), decodeURIComponent(pathname)))) : page.file;
    if (image) return relative(page.destination, copyImage(file));
    checkedFile(file, `Broken internal link in ${page.file} (${url})`);
    const target = pages.get(file);
    if (hash) {
      const headings = target?.headings ?? (file.endsWith('.md') ? parse(read(file)).headings : []);
      if (!headings.some((heading) => heading.id === decodeURIComponent(hash.slice(1)))) {
        throw new Error(`Broken internal link: ${page.file}: ${url} (heading not found)`);
      }
    }
    if (target) return (target === page && !pathname ? '' : relative(page.destination, target.destination)) + query + hash;
    return `${repository}/blob/main/${encodePath(file)}${query}${hash}`;
  }
  function rewriteTokens(tokens, page) {
    for (const token of tokens) {
      for (const [attribute, value] of token.attrs ?? []) {
        if (attribute === 'href' || attribute === 'src') token.attrSet(attribute, rewrite(value, page, attribute === 'src'));
      }
      if (token.children) rewriteTokens(token.children, page);
    }
  }
  const navigation = (destination, entries, label) => `<nav aria-label="${escape(label)}"><ul>${entries.map(([title, href]) => `<li><a href="${escape(relative(destination, href))}">${escape(title)}</a></li>`).join('')}</ul></nav>`;
  const mainLinks = [['Home', 'index.html'], ['User Guide', 'guide/index.html'], ['Upgrade notes', 'upgrade/index.html'], ['Changelog', 'changelog/index.html'], ['API reference', 'api/']];
  function shell(destination, title, body, guideNavigation = '') {
    const nav = navigation(destination, mainLinks, 'Main');
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · FileMaker Data API Tools</title><style>${stylesheet}</style></head><body>
<a class="skip-link" href="#main">Skip to content</a><header><a class="brand" href="${escape(relative(destination, 'index.html'))}">FileMaker Data API Tools</a>${nav}${guideNavigation}</header><main id="main">${body}</main><footer>FileMaker Data API Tools · Version ${escape(version)} · <a href="${repository}">GitHub repository</a> · <a href="${repository}/releases">Releases</a> · <a href="${marketplace}">Marketplace</a></footer></body></html>\n`;
  }
  for (const page of pages.values()) {
    rewriteTokens(page.tokens, page);
    const isChangelog = page.file === 'extension/CHANGELOG.md';
    const headings = page.headings.filter((h) => isChangelog ? h.level === 2 : h.level === 2 || h.level === 3);
    const label = isChangelog ? 'Versions' : 'On this page';
    const toc = `<nav class="toc" aria-label="${label}"><p><strong>${isChangelog ? 'Versions' : 'On this page'}</strong></p><ul>${headings.map((h) => `<li><a href="#${escape(h.id)}">${escape(h.title)}</a></li>`).join('')}</ul></nav>`;
    const guideLinks = [...pages.values()].filter((p) => p.destination.startsWith('guide/') && p !== pages.get('extension/docs/USER_GUIDE.md'))
      .sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true })).map((p) => [p.title, p.destination]);
    const guideNav = page.destination.startsWith('guide/') ? navigation(page.destination, guideLinks, 'Guide pages') : '';
    // Put the generated contents immediately after the document's first heading.
    const split = page.tokens.findIndex((token) => token.type === 'heading_close') + 1;
    const render = (tokens) => markdown.renderer.render(tokens, markdown.options, {});
    write(page.destination, shell(page.destination, page.title, render(page.tokens.slice(0, split)) + toc + render(page.tokens.slice(split)), guideNav));
  }
  // Use the opening paragraph of the current release, excluding its release date.
  const summarySource = current.source.replace(/^##[^\n]*\n/, '').replace(/^_Released[^\n]*\n/m, '').trim().split(/\r?\n\s*\r?\n/)[0];
  const summary = parse(summarySource);
  rewriteTokens(summary.tokens, { ...pages.get('extension/CHANGELOG.md'), destination: 'index.html' });
  write('index.html', shell('index.html', 'Home', `<h1>FileMaker Data API Tools</h1><p>Work with a FileMaker database from VS Code: connect to a server, find and edit records, compare layouts, export data, and understand connection problems. The extension is free, open source, and has no telemetry.</p><p>Current version: <strong>${escape(version)}</strong></p>${navigation('index.html', mainLinks.slice(1), 'Documentation')}<h2>What is new in ${escape(version)}</h2>${markdown.renderer.render(summary.tokens, markdown.options, {})}<p><a href="changelog/index.html#${escape(slug(version))}">Read all changes in ${escape(version)}</a></p>`));
  for (const file of readdirSync(path.join(root, 'extension/docs/marketplace'), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.png'))) {
    copyImage(`extension/docs/marketplace/${file.name}`);
  }
  write('.nojekyll', '');
  return pages.size + 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const flag = process.argv[i];
      if (!['--out', '--root'].includes(flag) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
        throw new Error('Usage: node tools/build-docs-site.mjs [--out pages] [--root repository]');
      }
      options[flag.slice(2)] = process.argv[i + 1];
    }
    const count = buildDocsSite(options);
    console.log(`Built ${count} documentation pages in ${path.resolve(options.out ?? 'pages')}`);
  } catch (error) {
    console.error(`Docs site build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
