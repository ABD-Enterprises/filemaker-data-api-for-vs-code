// Reusable user flows built on Session primitives.
import { assert } from './session.mjs';

/** Create a direct-auth profile through the wizard (test, then save). Returns when the wizard says "saved". */
export async function createProfile(s, { name, url, database, username = 'tester', password = 'testpass1', allowSelfSigned = false, caBundlePath = '' }) {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Add Connection Profile');
  const wv = await s.webview('#wizardForm');
  for (const [id, v] of Object.entries({ profileName: name, serverUrl: url, database, username, password })) await wv.locator(`#${id}`).fill(v);
  if (caBundlePath || allowSelfSigned) {
    await wv.locator('#certificateOptions summary').click();
    if (caBundlePath) await wv.locator('#caBundlePath').fill(caBundlePath);
    if (allowSelfSigned) await wv.locator('#allowSelfSigned').check();
  }
  await wv.locator('#testBtn').click();
  if (allowSelfSigned) await s.modal('Allow insecure connection', { timeout: 15000 });
  await wv.locator('#status:has-text("uccess"), #status:has-text("onnect")').first().waitFor({ timeout: 20000 });
  await wv.locator('#saveBtn').click();
  await wv.locator('#status:has-text("aved")').first().waitFor({ timeout: 15000 });
  await s.closeAllEditors();
}

/** FileMaker: Connect, choosing the profile by name if asked. */
export async function connect(s, name) {
  await s.cmd('FileMaker: Connect');
  await s.page.waitForTimeout(700);
  if (await s.pickerOpen()) await s.pick(name);
  const t = await s.waitToast(/onnected to/i, { timeout: 25000 });
  return t;
}

/** Make sure palette commands that depend on filemaker.hasProfiles are offered (the context key is stale after a first save). */
export async function ensureProfileCommands(s) {
  if ((await s.waitCmdListed('FileMaker: Connect', 4000)) >= 0) return false;
  await s.reloadWindow();
  assert((await s.waitCmdListed('FileMaker: Connect', 10000)) >= 0, 'Connect is not offered even after a window reload');
  return true;
}

/** Click a row in the FileMaker tree by its visible label. */
export async function treeRow(s, label) {
  const row = s.page.locator('.pane-body .monaco-list-row', { hasText: label }).first();
  await row.waitFor({ state: 'visible', timeout: 10000 });
  return row;
}
export async function expandTreeRow(s, label) {
  const row = await treeRow(s, label);
  const expanded = await row.getAttribute('aria-expanded');
  // A single click on a layout row opens the Query Builder, so use the twistie (or the Right arrow key).
  if (expanded !== 'true') await row.locator('.monaco-tl-twistie').first().click();
  await s.page.waitForTimeout(900);
}
export async function refreshExplorer(s) {
  const header = s.page.locator('.pane-header', { hasText: 'Connections' }).first();
  await header.hover();
  const btn = header.locator('.actions .codicon-refresh, .actions a[aria-label*="Refresh"]').first();
  if (await btn.count()) await btn.click({ timeout: 5000 });
  else await s.helper('executeCommand', { command: 'filemakerDataApiTools.refreshExplorer' });
  await s.page.waitForTimeout(1500);
}

/** Answer any quick pick that is open by choosing the first matching label from the list (profile, layout...). */
export async function answerPickers(s, labels, { max = 4 } = {}) {
  for (let i = 0; i < max; i += 1) {
    await s.page.waitForTimeout(700);
    if (!(await s.pickerOpen())) return;
    const items = await s.pickerItems();
    if (!items.length) return; // an input box, not a pick list
    let want = labels.find((l) => items.some((it) => it.toLowerCase().includes(l.toLowerCase())));
    if (!want && items.length >= 8) {
      // a long list is virtualised: the wanted entry may be below the fold, so filter by typing
      const title = await s.quickInputTitle().catch(() => '');
      want = /layout/i.test(title) ? labels[labels.length - 1] : labels[0];
    }
    if (!want) return;
    await s.pick(want);
  }
}

export async function openQueryBuilder(s, layout = 'Customers', profile = 'Mock Quality') {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Open Query Builder');
  await answerPickers(s, [profile, layout]);
  const wv = await s.webview('#runButton');
  await wv.locator('#runButton').waitFor({ state: 'visible', timeout: 15000 });
  return wv;
}

/** Clipboard text through the Electron main process (never the system pasteboard of another app). */
export async function readClipboard(s) {
  return s.app.evaluate(({ clipboard }) => clipboard.readText());
}
export async function writeClipboard(s, text) {
  return s.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

/** Answer VS Code's "simple dialog" file picker (files.simpleDialog.enable) with an absolute path. */
export async function answerFileDialog(s, absPath, { timeout = 10000 } = {}) {
  await s.quickInputOpen(timeout);
  await s.page.waitForTimeout(400);
  const box = s.page.locator('.quick-input-box input').first();
  await box.fill(absPath);
  await s.page.waitForTimeout(300);
  await s.page.keyboard.press('Enter');
  await s.page.waitForTimeout(600);
  // overwrite confirmation, if any
  if (await s.modalVisible()) { const b = await s.modalButtons(); await s.modal(b.find((x) => /replace|overwrite|yes/i.test(x)) ?? b[0]); }
}
