// Journey 12: install the published 1.3.0 from the Marketplace, set things up, upgrade to the build under test
// (a copy of the VSIX with a higher version number, so VS Code treats it as an update), uninstall and reinstall.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { connect, createProfile } from '../lib/flows.mjs';
import { assert, Session } from '../lib/session.mjs';

const J = 'J12 upgrade';
const EXT_ID = 'SureForgeTech.filemaker-data-api-tools';

function bumpVsix(src, version) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-e2e-vsix-'));
  execFileSync('unzip', ['-q', src, '-d', work]);
  const pj = path.join(work, 'extension', 'package.json');
  const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
  j.version = version;
  fs.writeFileSync(pj, JSON.stringify(j));
  const mf = path.join(work, 'extension.vsixmanifest');
  fs.writeFileSync(mf, fs.readFileSync(mf, 'utf8').replace(/(<Identity [^>]*Version=")[^"]+/, `$1${version}`));
  const out = path.join(os.tmpdir(), `fm-e2e-upgrade-${version}.vsix`);
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', out, '.'], { cwd: work });
  fs.rmSync(work, { recursive: true, force: true });
  return out;
}

export async function run(ctx) {
  const { s: main, mock, report, vscode, vsix } = ctx;
  await main.close();
  const u = new Session({ report, vscode, name: 'upgrade' });
  (ctx.cleanups ??= []).push(() => u.dispose());
  u.journey = J;
  const newer = bumpVsix(vsix, '1.4.0');
  (ctx.extraRoots ??= []).push(newer);

  let published;
  await u.step(J, 'install the published extension from the Marketplace into an isolated dir', 'the gallery serves SureForgeTech.filemaker-data-api-tools', async () => {
    const out = u.installVsix(EXT_ID, { force: false });
    published = u.listExtensions().find((e) => /filemaker-data-api-tools/i.test(e));
    assert(published, `installed: ${u.listExtensions().join(', ')}`);
    return `${out} | ${published}`;
  });
  await u.launch();
  await u.step(J, 'on the published build: create a profile, change a setting, save a query', 'profile saved with its password; setting written', async () => {
    await createProfile(u, { name: 'Upgrade Profile', url: mock.baseUrl, database: 'Quality' });
    u.writeSettings({ 'filemaker.batch.maxRecords': 1234, 'filemaker.history.maxEntries': 7 });
    await u.page.waitForTimeout(1500);
    const ext = (await u.helper('extensions')).find((e) => /filemaker-data-api-tools/i.test(e.id));
    return `running ${ext.id} ${ext.version}`;
  });
  await u.close();

  await u.step(J, 'install the newer build over it (--force, higher version)', 'VS Code replaces the old version with the new one', async () => {
    const out = u.installVsix(newer, { force: true });
    const list = u.listExtensions().filter((e) => /filemaker-data-api-tools/i.test(e));
    assert(list.length === 1 && /1\.4\.0/.test(list[0]), list.join(', '));
    return `${out} | now: ${list.join(', ')}`;
  });
  await u.launch();
  await u.step(J, 'after the upgrade: profile, secret and settings survive', 'profile is listed; Connect works without a password prompt; settings keep their values', async () => {
    const ext = (await u.helper('extensions')).find((e) => /filemaker-data-api-tools/i.test(e.id));
    assert(ext.version === '1.4.0', `running ${ext.version}`);
    assert((await u.waitCmdListed('FileMaker: Connect', 8000)) >= 0, 'Connect not offered: profiles lost after the upgrade');
    const t = await connect(u, 'Upgrade Profile');
    const maxRecords = (await u.helper('getConfig', { key: 'filemaker.batch.maxRecords' })).value;
    assert(maxRecords === 1234, `batch.maxRecords = ${maxRecords}`);
    return `${t} | running ${ext.version}`;
  });
  await u.step(J, 'uninstall, then reinstall: data after reinstall', 'documented outcome: profiles are kept or removed consistently', async () => {
    await u.close();
    u.uninstall(EXT_ID);
    assert(!u.listExtensions().some((e) => /filemaker/i.test(e)), 'still installed');
    u.installVsix(newer, { force: true });
    await u.launch();
    const listed = (await u.waitCmdListed('FileMaker: Connect', 8000)) >= 0;
    await u.openFileMakerSidebar();
    const rows = await u.treeRows();
    return `after uninstall+reinstall: Connect offered=${listed}; tree: ${rows.slice(0, 3).join(' | ')}`;
  });
  await u.close();
}
