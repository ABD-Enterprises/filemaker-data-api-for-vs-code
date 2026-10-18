#!/usr/bin/env node
// Real VS Code UI end-to-end tests. Run with `npm run test:e2e-ui` from extension/.
//   E2E_ONLY=j02,j03      run only these journeys (prefix match on the journey file name)
//   E2E_KEEP=1            keep the temp profile and leave VS Code logs in the artifacts folder
//   E2E_ARTIFACTS=dir     where screenshots and the report go (default: <repo>/artifacts/e2e-ui/<timestamp>)
//   E2E_VSCODE_VERSION    VS Code version for @vscode/test-electron (default: stable)
//   E2E_VSCODE_CACHE      download cache (default: <tmp>/fm-e2e-vscode-cache)
//   E2E_VSIX              VSIX to test (default: ../artifacts/filemaker-data-api-tools-<version>.vsix)
// Skips cleanly (exit 0 and a message) when prerequisites are missing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMock } from './lib/mock.mjs';
import { Report } from './lib/report.mjs';
import { getVSCode, loadDeps, Session } from './lib/session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const repoRoot = path.resolve(extDir, '..');

function skip(reason) {
  console.log(`E2E UI tests skipped: ${reason}`);
  process.exit(0);
}

const deps = loadDeps();
if (deps.error) skip(deps.error);
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
  skip('no display (set DISPLAY, or run under xvfb-run -a npm run test:e2e-ui)');
const version = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8')).version;
const vsix =
  process.env.E2E_VSIX ??
  path.join(repoRoot, 'artifacts', `filemaker-data-api-tools-${version}.vsix`);
if (!fs.existsSync(vsix))
  skip(
    `no VSIX at ${vsix}. Build it first: npm run build -w shared && npm run package:check (from the repo root / extension/)`
  );

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = process.env.E2E_ARTIFACTS ?? path.join(repoRoot, 'artifacts', 'e2e-ui', stamp);
fs.mkdirSync(artifacts, { recursive: true });
const report = new Report(artifacts);
const t0 = Date.now();

const only = (process.env.E2E_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const journeyFiles = fs
  .readdirSync(path.join(here, 'journeys'))
  .filter((f) => /^j\d+.*\.mjs$/.test(f))
  .sort();
const selected = journeyFiles.filter((f) => !only.length || only.some((o) => f.startsWith(o)));

let vscode;
try {
  vscode = await getVSCode();
} catch (e) {
  skip(`could not obtain VS Code (${e.message})`);
}

const mock = await startMock();
const s = new Session({ report, vscode, name: 'main' });
const ctx = {
  s,
  mock,
  report,
  vsix,
  artifacts,
  extDir,
  repoRoot,
  vscode,
  helperDir: path.join(here, 'helper-extension'),
  version
};
let exitCode = 0;
const cleanup = async () => {
  try {
    await s.dispose({ keepLogsTo: path.join(artifacts, 'vscode-logs') });
  } catch {
    /* best effort */
  }
  try {
    await mock.stop();
  } catch {
    /* best effort */
  }
  for (const fn of ctx.cleanups ?? []) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
  for (const dir of ctx.extraRoots ?? []) fs.rmSync(dir, { recursive: true, force: true });
};
process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});
try {
  s.installVsix(vsix);
  console.log(
    `VS Code ${path.basename(path.dirname(path.dirname(path.dirname(path.dirname(vscode.exe)))))} | mock ${mock.baseUrl} | artifacts ${artifacts}`
  );
  for (const file of selected) {
    const mod = await import(path.join(here, 'journeys', file));
    console.log(`\n=== ${file} ===`);
    if (s.app) for (const w of s.app.windows()) if (w !== s.page) await w.close().catch(() => {}); // a stray second window steals key events
    try {
      if (!s.app && !mod.ownsLaunch) await s.launch();
      else if (s.app && !s.helperOn && !mod.ownsLaunch) await s.restart();
      await mod.run(ctx);
    } catch (e) {
      exitCode = 1;
      report.add({
        journey: file,
        step: 'journey crashed',
        expect: 'journey completes',
        result: 'FAIL',
        shot: await s.shot('crash', file),
        detail: e.stack ?? String(e)
      });
    }
    report.write();
  }
} finally {
  report.write();
  await cleanup();
}
const failed = report.rows.filter((r) => r.result === 'FAIL').length;
console.log(
  `\nDone in ${Math.round((Date.now() - t0) / 1000)}s: ${report.rows.length} steps, ${failed} failed. Report: ${path.join(artifacts, 'report.md')}`
);
process.exit(exitCode || (failed ? 1 : 0));
