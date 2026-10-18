// Journey 2: create a connection with the wizard (direct auth), validation, wrong password, test, save, TLS options, template.
import fs from 'node:fs';
import path from 'node:path';

import { startMock } from '../lib/mock.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J02 wizard';
const text = async (wv, sel) => (await wv.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();

async function openWizard(s, cmd = 'FileMaker: Add Connection Profile') {
  await s.closeAllEditors();
  await s.cmd(cmd);
  return s.webview('#wizardForm');
}
async function fill(wv, values) {
  for (const [id, v] of Object.entries(values)) await wv.locator(`#${id}`).fill(v);
}
const status = (wv) => text(wv, '#status');

export async function run(ctx) {
  const { s, mock } = ctx;
  let wv = await openWizard(s);

  await s.step(J, 'wizard opens as an editor tab with Profile, Server, Credentials sections', 'form visible with all fields and the Test/Save buttons', async () => {
    for (const id of ['profileName', 'serverUrl', 'database', 'username', 'password', 'testBtn', 'saveBtn']) assert(await wv.locator(`#${id}`).count(), `missing #${id}`);
    assert((await s.editorTabs()).some((t) => /Add Connection Profile/.test(t)), 'tab title');
  });
  await s.step(J, 'Save with an empty form', 'a validation message names the required fields; nothing is saved', async () => {
    await wv.locator('#saveBtn').click();
    await s.page.waitForTimeout(500);
    const st = await status(wv);
    assert(/required/i.test(st), `status: ${st}`);
    return st;
  });
  await s.step(J, 'Test Connection with wrong password', 'a readable failure (account/password invalid), badge red', async () => {
    await fill(wv, { profileName: 'Mock Quality', serverUrl: mock.baseUrl, database: 'Quality', username: 'tester', password: 'wrong-password' });
    await wv.locator('#testBtn').click();
    await wv.locator('#status.error, #status .error, #status:has-text("nvalid"), #status:has-text("fail")').first().waitFor({ timeout: 20000 }).catch(() => {});
    await s.page.waitForTimeout(1500);
    const st = await status(wv);
    assert(/password|account|invalid|credential|212|401/i.test(st), `status: ${st}`);
    return st;
  });
  await s.step(J, 'Test Connection with the right password', 'success message and green badge', async () => {
    await wv.locator('#password').fill('testpass1');
    await wv.locator('#testBtn').click();
    await wv.locator('#status:has-text("uccess"), #status:has-text("onnect")').first().waitFor({ timeout: 20000 });
    const st = await status(wv);
    assert(!/fail|invalid/i.test(st), st);
    const log = await mock.log();
    const posts = log.filter((l) => l.method === 'POST' && l.path === '/sessions');
    const deletes = log.filter((l) => l.method === 'DELETE' && l.path.startsWith('/sessions'));
    return `${st} | mock saw ${posts.length} logins, ${deletes.length} logouts`;
  });
  await s.step(J, 'Save the profile', 'confirmation shown; profile appears in the FileMaker sidebar', async () => {
    await wv.locator('#saveBtn').click();
    await wv.locator('#status:has-text("aved")').first().waitFor({ timeout: 15000 });
    await s.openFileMakerSidebar();
    await s.page.waitForTimeout(800);
    const rows = await s.treeRows();
    assert(rows.some((r) => /Mock Quality/.test(r)), `tree: ${rows.join(' | ')}`);
  });
  await s.step(J, 'after the first save, Connect and Edit are offered in the palette', 'FileMaker: Connect is listed without reloading the window', async () => {
    const ms = await s.waitCmdListed('FileMaker: Connect', 12000);
    if (ms < 0) { await s.reloadWindow(); const after = await s.waitCmdListed('FileMaker: Connect', 8000); throw new Error(`Connect not offered within 12s of saving the first profile; ${after >= 0 ? 'appeared only after a window reload' : 'not offered even after reload'} (context key filemaker.hasProfiles is not refreshed by the wizard save)`); }
    return `listed after ${ms} ms`;
  });
  await s.step(J, 'secret is stored: Connect works without being asked for a password', 'FileMaker: Connect succeeds using the stored secret (no password prompt)', async () => {
    await s.closeAllEditors();
    await s.cmd('FileMaker: Connect');
    await s.page.waitForTimeout(800);
    const prompted = await s.pickerOpen();
    if (prompted) await s.pick('Mock Quality');
    const t = await s.waitToast(/onnected/i, { timeout: 20000 });
    return `${t} | profile picker shown with a single saved profile: ${prompted}`;
  });

  // ---- edit, password prompt on server change -------------------------------------------
  await s.step(J, 'edit profile: changing the server address requires the password again', 'Test says to enter the password; saved one is not sent elsewhere', async () => {
    await s.closeAllEditors();
    await s.cmd('FileMaker: Edit Connection Profile');
    await s.page.waitForTimeout(800);
    if (await s.pickerOpen()) await s.pick('Mock Quality');
    wv = await s.webview('#wizardForm');
    await wv.locator('#serverUrl').fill(mock.baseUrl.replace('127.0.0.1', 'localhost'));
    await wv.locator('#testBtn').click();
    await s.page.waitForTimeout(2500);
    const st = await status(wv);
    assert(/password/i.test(st), `status: ${st}`);
    return st;
  });
  await s.step(J, 'edit profile: unchanged address keeps the saved password', 'Test succeeds with the password field blank', async () => {
    await wv.locator('#serverUrl').fill(mock.baseUrl);
    await wv.locator('#testBtn').click();
    await wv.locator('#status:has-text("uccess"), #status:has-text("onnect")').first().waitFor({ timeout: 20000 });
  });

  // ---- http:// warning ---------------------------------------------------------------------
  await s.step(J, 'http:// to a non-local address warns before credentials are sent', 'a modal names the address and offers "Continue anyway" / cancel', async () => {
    wv = await openWizard(s);
    await fill(wv, { profileName: 'Insecure', serverUrl: 'http://fm-insecure.test:9', database: 'Quality', username: 'tester', password: 'x' });
    await wv.locator('#testBtn').click();
    const t = await s.waitModal(15000);
    assert(/unencrypted|http/i.test(t), t);
    const buttons = await s.modalButtons();
    await s.shot('http-warning');
    await s.modal('Cancel').catch(async () => s.escape());
    await s.page.waitForTimeout(800);
    const st = await status(wv);
    return `${t} | buttons ${buttons.join('/')} | after cancel: ${st}`;
  });
  await s.step(J, 'loopback http:// is not warned about', 'no modal for 127.0.0.1', async () => {
    await fill(wv, { profileName: 'Loop', serverUrl: mock.baseUrl, password: 'testpass1' });
    await wv.locator('#testBtn').click();
    await s.page.waitForTimeout(1500);
    assert(!(await s.modalVisible()), 'unexpected modal');
  });

  // ---- Certificates (advanced) against a TLS mock ----------------------------------------
  const tls = await startMock({ TLS: 'self-signed' });
  const ca = await startMock({ TLS: 'ca' });
  (ctx.cleanups ??= []).push(() => tls.stop(), () => ca.stop());
  wv = await openWizard(s);
  await fill(wv, { profileName: 'TLS self-signed', serverUrl: tls.baseUrl, database: 'Quality', username: 'tester', password: 'testpass1' });
  await s.step(J, 'self-signed server without any option', 'Test fails with a certificate message (not a generic error)', async () => {
    await wv.locator('#testBtn').click();
    await s.page.waitForTimeout(4000);
    const st = await status(wv);
    assert(/certificate|self.signed|SSL|TLS/i.test(st), `status: ${st}`);
    return st;
  });
  await s.step(J, 'Certificates (advanced) section', 'collapsed by default; contains CA path field and the insecure checkbox', async () => {
    const open = await wv.locator('#certificateOptions').evaluate((el) => el.open);
    assert(open === false, 'expected collapsed');
    await wv.locator('#certificateOptions summary').click();
    assert(await wv.locator('#caBundlePath').isVisible() && (await wv.locator('#allowSelfSigned').isVisible()), 'fields not visible');
  });
  await s.step(J, 'invalid CA path', 'validation error naming the problem', async () => {
    await wv.locator('#caBundlePath').fill('/nonexistent/ca.pem');
    await wv.locator('#testBtn').click();
    await s.page.waitForTimeout(2500);
    const st = await status(wv);
    assert(/CA|certificate|read|exist|PEM/i.test(st), st);
    return st;
  });
  await s.step(J, 'wrong CA file (not PEM)', 'rejected as not a PEM certificate', async () => {
    const bad = path.join(s.ws, 'not-a-ca.pem');
    fs.writeFileSync(bad, 'hello');
    await wv.locator('#caBundlePath').fill(bad);
    await wv.locator('#testBtn').click();
    await s.page.waitForTimeout(2500);
    const st = await status(wv);
    assert(/PEM|certificate|valid/i.test(st), st);
    return st;
  });
  await s.step(J, 'allow self-signed: confirmation modal, decline', 'modal names the https address; declining aborts the test', async () => {
    await wv.locator('#caBundlePath').fill('');
    await wv.locator('#allowSelfSigned').check();
    await wv.locator('#testBtn').click();
    const t = await s.waitModal(15000);
    assert(/Accept any certificate/i.test(t) && t.includes(new URL(tls.baseUrl).origin), t);
    await s.modal('Cancel').catch(() => s.escape());
    await s.page.waitForTimeout(1200);
    return `${t.slice(0, 100)} | after: ${await status(wv)}`;
  });
  await s.step(J, 'allow self-signed: accept', 'Allow insecure connection -> Test succeeds', async () => {
    await wv.locator('#testBtn').click();
    await s.modal('Allow insecure connection', { timeout: 15000 });
    await wv.locator('#status:has-text("uccess"), #status:has-text("onnect")').first().waitFor({ timeout: 20000 });
  });
  await s.step(J, 'allow-self-signed on an http:// address', 'form refuses with an explanation', async () => {
    await wv.locator('#serverUrl').fill(mock.baseUrl);
    await wv.locator('#testBtn').click();
    await s.page.waitForTimeout(2500);
    const st = await status(wv);
    assert(/https/i.test(st), st);
    return st;
  });
  await s.step(J, 'private CA: trusted through the CA file', 'Test succeeds with only the CA path (no insecure box)', async () => {
    await wv.locator('#allowSelfSigned').uncheck();
    await wv.locator('#serverUrl').fill(ca.baseUrl);
    await wv.locator('#caBundlePath').fill(ca.caPath);
    await wv.locator('#testBtn').click();
    await wv.locator('#status:has-text("uccess"), #status:has-text("onnect")').first().waitFor({ timeout: 20000 });
  });
  await s.step(J, 'private CA server without the CA file', 'fails with a certificate message', async () => {
    await wv.locator('#caBundlePath').fill('');
    await wv.locator('#testBtn').click();
    await s.page.waitForTimeout(4000);
    const st = await status(wv);
    assert(/certificate|SSL|TLS|issuer|trust/i.test(st), st);
    return st;
  });
  await s.step(J, 'save a TLS profile with the CA file', 'saved; reopening shows the section open with the path', async () => {
    await wv.locator('#caBundlePath').fill(ca.caPath);
    await wv.locator('#profileName').fill('TLS private CA');
    await wv.locator('#testBtn').click();
    await wv.locator('#status:has-text("uccess"), #status:has-text("onnect")').first().waitFor({ timeout: 20000 });
    await wv.locator('#saveBtn').click();
    await wv.locator('#status:has-text("aved")').first().waitFor({ timeout: 15000 }).catch(async () => { throw new Error(`not saved: status="${await status(wv)}" modal=${await s.modalVisible() ? await s.modalText() : 'none'}`); });
  });

  // ---- workspace profile template --------------------------------------------------------
  await s.step(J, 'workspace profile template pre-fills the wizard and names its host', 'banner says the address came from the workspace file; locked fields read-only; password prompt for unknown host', async () => {
    fs.mkdirSync(path.join(s.ws, '.filemaker'), { recursive: true });
    fs.writeFileSync(path.join(s.ws, '.filemaker', 'profile-template.json'), JSON.stringify({ name: 'Team Dev', authMode: 'direct', serverUrl: 'https://fm-team.example.test', database: 'TeamApp', username: 'dev', locked: true }));
    wv = await openWizard(s);
    await wv.locator('#profileTemplateBanner').waitFor({ timeout: 10000 });
    const banner = await text(wv, '#profileTemplateBanner');
    assert(/fm-team\.example\.test/.test(banner), banner);
    const ro = (id) => wv.locator(`#${id}`).evaluate((el) => el.readOnly || el.disabled);
    assert(await ro('database'), 'database should be locked');
    const serverLocked = await ro('serverUrl');
    return `${banner} | serverUrl locked: ${serverLocked} (docs/PROFILE_TEMPLATES.md says "locked" locks serverUrl; code keeps it editable on purpose: profileTemplate.ts:7)`;
  });
  await s.step(J, 'template with a secret is ignored with a warning', 'a non-fatal warning; no prefill', async () => {
    fs.writeFileSync(path.join(s.ws, '.filemaker', 'profile-template.json'), JSON.stringify({ name: 'Leaky', serverUrl: 'https://x.example.test', database: 'D', username: 'u', password: 'secret' }));
    wv = await openWizard(s);
    await s.page.waitForTimeout(1500);
    const st = await status(wv);
    assert(/template|ignored/i.test(st), `status: ${st}`);
    assert((await wv.locator('#profileName').inputValue()) === '', 'form was prefilled');
    return st;
  });
  fs.rmSync(path.join(s.ws, '.filemaker'), { recursive: true, force: true });
  await s.closeAllEditors();
}
