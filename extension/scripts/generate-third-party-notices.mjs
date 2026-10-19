// Writes THIRD_PARTY_NOTICES.txt: the name, version, licence and full licence text of every
// third-party package that is bundled into the extension (dist/extension.js,
// dist/schemaDiffWorker.js and, when it is built, the Layout Mode UI).
//
// How it knows what is bundled: it runs the same esbuild builds as the real bundles (see
// esbuild-config.mjs) without writing any output, and reads the metafile's list of input files.
// Every file under a `node_modules/<package>` directory marks that package as bundled.
//
//   node scripts/generate-third-party-notices.mjs           write THIRD_PARTY_NOTICES.txt
//   node scripts/generate-third-party-notices.mjs --check   fail if it is stale, or if a bundled
//                                                           package has no licence file
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { extensionBundles, extensionDir } from './esbuild-config.mjs';

export const NOTICES_PATH = path.join(extensionDir, 'THIRD_PARTY_NOTICES.txt');
const designerDir = path.resolve(extensionDir, '..', 'designer-ui');

/** Same options as `designer-ui`'s own `build` script (keep them in step; a unit test checks). */
function designerBundle() {
  return {
    entryPoints: [path.join(designerDir, 'src/main.tsx')],
    outfile: path.join(designerDir, 'dist/index.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    // Resolve the workspace package from its source so the list does not depend on whether
    // shared/dist has been built yet (CI runs the tests before the build).
    alias: { '@fmweb/shared': path.resolve(designerDir, '..', 'shared/src/index.ts') },
    logLevel: 'error'
  };
}

function designerBuildable() {
  if (!existsSync(designerDir)) {
    return false;
  }
  const requireFromDesigner = createRequire(path.join(designerDir, 'package.json'));
  return ['react', 'react-dom/client', '@fmweb/shared/package.json'].every((specifier) => {
    try {
      requireFromDesigner.resolve(specifier);
      return true;
    } catch {
      return false;
    }
  });
}

/** `/a/node_modules/@scope/pkg/lib/x.js` -> { name: '@scope/pkg', dir: '/a/node_modules/@scope/pkg' } */
function packageOfInput(inputPath) {
  const marker = 'node_modules/';
  const index = inputPath.lastIndexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const rest = inputPath.slice(index + marker.length).split('/');
  const parts = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  return {
    name: parts.join('/'),
    dir: path.resolve(extensionDir, inputPath.slice(0, index + marker.length), ...parts)
  };
}

function licenseFilesOf(dir) {
  return readdirSync(dir)
    .filter((entry) => /^(licen[sc]e|copying|notice)(\.(md|txt|markdown))?$/i.test(entry))
    .sort();
}

/**
 * A few packages (agent-base 6, https-proxy-agent 5) ship no LICENSE file and carry the full
 * licence text in the README's "License" section instead. Take it from there, but only when
 * the section really is a licence grant; anything else counts as "no notice".
 */
function licenseTextFromReadme(dir) {
  const readme = readdirSync(dir).find((entry) => /^readme(\.(md|markdown|txt))?$/i.test(entry));
  if (!readme) {
    return undefined;
  }
  const text = readFileSync(path.join(dir, readme), 'utf8').replace(/\r\n?/g, '\n');
  // "## License" or a "License" line underlined with dashes.
  const match = /^#{0,6}[ \t]*licen[sc]e[ \t]*\n(?:[-=]{3,}[ \t]*\n)?/im.exec(text);
  if (!match) {
    return undefined;
  }
  const section = text
    .slice(match.index + match[0].length)
    .replace(/(\n\[[^\]\n]+\]:[^\n]*)+\s*$/, '') // trailing markdown link definitions
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
  return /Copyright \(c\)|Copyright ©|Copyright \d{4}/i.test(section) &&
    /Permission is hereby granted|Redistribution and use|Licensed under the Apache License/i.test(section)
    ? section
    : undefined;
}

function describeLicense(manifest) {
  if (typeof manifest.license === 'string') {
    return manifest.license;
  }
  if (manifest.license && typeof manifest.license.type === 'string') {
    return manifest.license.type;
  }
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((entry) => entry.type).join(' OR ');
  }
  return 'UNKNOWN';
}

/**
 * Every third-party package that ends up in a shipped bundle, with its licence text.
 * `missing` lists packages that bundled but have no licence file, which `--check` (and the
 * unit test) treat as a failure: a bundled package without a notice cannot ship.
 */
export async function collectBundledPackages() {
  const builds = [
    ['extension', extensionBundles.extension],
    ['schema-diff-worker', extensionBundles.worker]
  ];
  if (designerBuildable()) {
    builds.push(['layout-mode-ui', designerBundle()]);
  }

  const found = new Map();
  for (const [bundleName, options] of builds) {
    const result = await build({
      ...options,
      absWorkingDir: extensionDir,
      write: false,
      metafile: true,
      logLevel: 'error'
    });
    for (const inputPath of Object.keys(result.metafile.inputs)) {
      const pkg = packageOfInput(inputPath);
      if (!pkg) {
        continue;
      }
      const entry = found.get(pkg.dir) ?? { ...pkg, bundles: new Set() };
      entry.bundles.add(bundleName);
      found.set(pkg.dir, entry);
    }
  }

  const packages = [];
  const missing = [];
  for (const entry of found.values()) {
    const manifest = JSON.parse(readFileSync(path.join(entry.dir, 'package.json'), 'utf8'));
    const files = licenseFilesOf(entry.dir);
    const readmeText = files.length === 0 ? licenseTextFromReadme(entry.dir) : undefined;
    if (files.length === 0 && !readmeText) {
      missing.push(`${manifest.name ?? entry.name}@${manifest.version}`);
      continue;
    }
    const repository =
      typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url ?? '');
    packages.push({
      name: manifest.name ?? entry.name,
      version: manifest.version,
      license: describeLicense(manifest),
      repository: repository.replace(/^git\+/, ''),
      bundles: [...entry.bundles].sort(),
      text:
        readmeText ??
        files
          .map((file) => readFileSync(path.join(entry.dir, file), 'utf8').replace(/\r\n?/g, '\n').trim())
          .join('\n\n')
    });
  }

  // Plain code-unit comparison: localeCompare depends on the machine's locale.
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  packages.sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  missing.sort();
  return { packages, missing };
}

export function renderNotices(packages) {
  const lines = [
    'THIRD-PARTY NOTICES',
    '',
    'FileMaker Data API Tools bundles the open-source packages listed below. Each is',
    'used under its own licence, reproduced here as the licence requires.',
    'This file is generated by scripts/generate-third-party-notices.mjs; do not edit it by hand.',
    ''
  ];
  for (const pkg of packages) {
    lines.push(
      '='.repeat(78),
      `${pkg.name} ${pkg.version}`,
      `License: ${pkg.license}`,
      ...(pkg.repository ? [`Source: ${pkg.repository}`] : []),
      '='.repeat(78),
      '',
      pkg.text,
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const { packages, missing } = await collectBundledPackages();
  if (missing.length > 0) {
    console.error(`[notices] These bundled packages have no licence file, so no notice can be written:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }

  const text = renderNotices(packages);
  if (check) {
    const current = existsSync(NOTICES_PATH) ? readFileSync(NOTICES_PATH, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== text) {
      console.error('[notices] THIRD_PARTY_NOTICES.txt is out of date. Run "npm run notices" in extension/ and commit it.');
      process.exit(1);
    }
    console.log(`[notices] THIRD_PARTY_NOTICES.txt is current (${packages.length} packages).`);
    return;
  }

  writeFileSync(NOTICES_PATH, text);
  console.log(`[notices] Wrote THIRD_PARTY_NOTICES.txt (${packages.length} packages).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
