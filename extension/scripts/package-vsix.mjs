// Builds the VSIX into ../artifacts/. A script instead of an npm one-liner because the version in
// the file name came from `${npm_package_version}`, which only a POSIX shell expands: cmd.exe wrote
// a file literally named `...-${npm_package_version}.vsix`. It also finds vsce without `.cmd` shims.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { validateVsix } from './validate-vsix.mjs';

const extensionDir = path.resolve(import.meta.dirname, '..');
const artifacts = path.resolve(extensionDir, '..', 'artifacts');
const { version } = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));

const require = createRequire(import.meta.url);
const vscePackage = require.resolve('@vscode/vsce/package.json');
const vsceBin = path.join(path.dirname(vscePackage), JSON.parse(readFileSync(vscePackage, 'utf8')).bin.vsce);

const vsixPath = path.join(artifacts, `filemaker-data-api-tools-${version}.vsix`);

mkdirSync(artifacts, { recursive: true });
execFileSync(
  process.execPath,
  [
    vsceBin,
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--baseContentUrl',
    'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension',
    '--baseImagesUrl',
    'https://raw.githubusercontent.com/SureForgeTech/filemaker-data-api-for-vs-code/main/extension',
    '--out',
    vsixPath
  ],
  { cwd: extensionDir, stdio: 'inherit' }
);

await validateVsix(vsixPath);
