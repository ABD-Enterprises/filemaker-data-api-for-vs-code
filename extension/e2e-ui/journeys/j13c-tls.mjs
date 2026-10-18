// Journey 13c: TLS failure modes through the connection wizard (docs/FILEMAKER_FAILURE_MODES.md section 1).
// Test Connection against the mock in each TLS mode, with and without the Certificates (advanced) options, and
// then Connect from a saved profile to see the toast and its buttons.
import fs from 'node:fs';
import path from 'node:path';

import { startMock } from '../lib/mock.mjs';
import { connectAction, observe, summarise } from '../lib/observe.mjs';
import { createProfile, ensureProfileCommands } from '../lib/flows.mjs';

const J = 'J13c TLS';
const BARE = /^Failed to create FileMaker session\.?\s*$/;

async function wizardTest(s, { url, name = 'tls-probe', ca = '', allow = false, password = 'testpass1' }) {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Add Connection Profile');
  const wv = await s.webview('#wizardForm');
  for (const [id, v] of Object.entries({ profileName: name, serverUrl: url, database: 'Quality', username: 'tester', password })) await wv.locator(`#${id}`).fill(v);
  if (ca || allow) {
    await wv.locator('#certificateOptions summary').click();
    if (ca) await wv.locator('#caBundlePath').fill(ca);
    if (allow) await wv.locator('#allowSelfSigned').check();
  }
  await wv.locator('#testBtn').click();
  if (allow) { await s.modal('Allow insecure connection', { timeout: 15000 }).catch(() => {}); }
  await wv.locator('#status:not(:empty)').first().waitFor({ timeout: 40000 });
  await s.page.waitForTimeout(1500);
  const st = (await wv.locator('#status').innerText()).replace(/\s+/g, ' ').trim();
  return { st, wv };
}

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) { await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' }); ctx.profileMain = true; }
  await ensureProfileCommands(s);
  await s.setSetting('filemaker.requestTimeoutMs', 5000);
  const mocks = {};
  const modes = ['expired', 'notyet', 'wronghost', 'missing-intermediate', 'tls10-only', 'self-signed', 'ca'];
  for (const m of modes) { mocks[m] = await startMock({ TLS: m }); (ctx.cleanups ??= []).push(() => mocks[m].stop()); }

  const row = (name, expectText, fn) => s.step(J, name, expectText, fn);
  const judge = (st, mustMention, gapMsg) => { if (BARE.test(st) || !mustMention.test(st)) throw new Error(`${gapMsg} :: shown: "${st}"`); return `shown: "${st}"`; };

  // 1.1 - 1.5: the CA is trusted (CA file set) so the specific certificate problem is what remains.
  await row('1.1 expired certificate (CA file trusted)', 'says the certificate expired (code CERT_HAS_EXPIRED), no Retry', async () => {
    const { st } = await wizardTest(s, { url: mocks.expired.baseUrl, ca: mocks.expired.caPath });
    return judge(st, /expired/i, 'the wizard does not say the certificate expired (confirms 1.1/B1)');
  });
  await row('1.2 certificate not yet valid', 'says not yet valid / check the computer clock', async () => {
    const { st } = await wizardTest(s, { url: mocks.notyet.baseUrl, ca: mocks.notyet.caPath });
    return judge(st, /not yet valid|clock|date/i, 'no mention of not-yet-valid or the clock (confirms 1.2/B1)');
  });
  await row('1.5 hostname mismatch', 'names the certificate host vs the connected host', async () => {
    const { st } = await wizardTest(s, { url: mocks.wronghost.baseUrl, ca: mocks.wronghost.caPath });
    return judge(st, /host|name|altnames|match/i, 'no mention of a hostname mismatch (confirms 1.5/B1)');
  });
  await row('1.3 self-signed server, no option', 'points at Certificates (advanced) / CA file', async () => {
    const { st } = await wizardTest(s, { url: mocks['self-signed'].baseUrl });
    return judge(st, /Certificates \(advanced\)|CA certificate file|trusted authority|does not trust/i, 'the message shows only Node text, no pointer to the CA option (confirms 1.3 message gap)');
  });
  await row('1.4 private CA not trusted (no CA file)', 'says this computer does not trust the issuing authority', async () => {
    const { st } = await wizardTest(s, { url: mocks.ca.baseUrl });
    return judge(st, /does not trust|Certificates \(advanced\)|CA certificate file|trusted authority/i, 'Node wording only: "unable to verify the first certificate" (confirms 1.4)');
  });
  await row('1.7 missing intermediate (CA file = root only)', 'explains an incomplete chain / install the intermediate', async () => {
    const { st } = await wizardTest(s, { url: mocks['missing-intermediate'].baseUrl, ca: mocks['missing-intermediate'].caPath });
    return judge(st, /intermediate|chain|incomplete/i, 'same text as 1.4: cannot tell an incomplete chain from an untrusted CA (confirms 1.7)');
  });
  await row('1.7b missing intermediate, CA file = root + intermediate', 'connects (workaround from the catalogue)', async () => {
    const both = path.join(s.ws, 'root-and-intermediate.pem');
    fs.writeFileSync(both, fs.readFileSync(mocks['missing-intermediate'].caPath, 'utf8') + fs.readFileSync(mocks['missing-intermediate'].intermediatePath, 'utf8'));
    const { st } = await wizardTest(s, { url: mocks['missing-intermediate'].baseUrl, ca: both });
    if (!/uccess|onnect/i.test(st)) throw new Error(`did not connect: ${st}`);
    return st;
  });
  await row('1.11 server offers only TLS 1.0/1.1', 'says the server only supports old TLS versions', async () => {
    const { st } = await wizardTest(s, { url: mocks['tls10-only'].baseUrl, ca: mocks['tls10-only'].caPath });
    return judge(st, /TLS|protocol|version|old/i, 'bare text only (confirms 1.11)');
  });
  await row('1.9 "Allow self-signed" accepts an EXPIRED certificate', 'documented as all-or-nothing: accepted (the checkbox disables every check)', async () => {
    const { st } = await wizardTest(s, { url: mocks.expired.baseUrl, allow: true });
    if (!/uccess|onnect/i.test(st)) throw new Error(`expected the insecure option to connect, got: ${st}`);
    return `${st} (the insecure checkbox hides an expired certificate too, as the catalogue says)`;
  });
  await row('1.13 http:// profile pointed at the TLS port', 'says the server did not answer plain http / try https', async () => {
    const { st } = await wizardTest(s, { url: mocks.ca.baseUrl.replace('https://', 'http://') });
    return judge(st, /https|plain http|TLS/i, 'bare text only (confirms 1.13)');
  });
  await row('1.14 https:// profile pointed at a plain-HTTP port', 'says that port does not speak https', async () => {
    const { st } = await wizardTest(s, { url: mock.baseUrl.replace('http://', 'https://') });
    return judge(st, /https|port|TLS|protocol/i, 'bare text only (confirms 1.14)');
  });
  await row('1.15 nothing listening on the port', 'names host:port', async () => {
    const { st } = await wizardTest(s, { url: 'http://127.0.0.1:1' });
    return judge(st, /127\.0\.0\.1|port|refused|listening/i, 'bare text only (confirms 1.15)');
  });
  await row('1.16 DNS failure', 'names the host that could not be found', async () => {
    const { st } = await wizardTest(s, { url: 'https://no-such-host.invalid' });
    return judge(st, /no-such-host|name|DNS|found/i, 'bare text only (confirms 1.16)');
  });

  // Connect from a saved profile: toast and buttons for the expired certificate.
  await row('1.1b saved profile with an expired server certificate: Connect', 'toast text names the problem; Retry is not offered for a certificate error', async () => {
    const { wv } = await wizardTest(s, { url: mocks.expired.baseUrl, name: 'TLS expired', allow: true });
    await wv.locator('#saveBtn').click();
    await wv.locator('#status:has-text("aved")').first().waitFor({ timeout: 15000 });
    await s.closeAllEditors();
    // switch off "allow" by editing: simpler to point the saved profile at the CA-trusted but expired cert
    await s.cmd('FileMaker: Edit Connection Profile');
    await s.page.waitForTimeout(600);
    if (await s.pickerOpen()) await s.pick('TLS expired');
    const w2 = await s.webview('#wizardForm');
    if (!(await w2.locator('#certificateOptions').evaluate((el) => el.open))) await w2.locator('#certificateOptions summary').click();
    await w2.locator('#allowSelfSigned').uncheck();
    await w2.locator('#caBundlePath').fill(mocks.expired.caPath);
    await w2.locator('#password').fill('testpass1');
    await w2.locator('#saveBtn').click();
    await s.page.waitForTimeout(800);
    if (await s.modalVisible()) { const b = await s.modalButtons(); await s.modal(b.find((x) => /save|continue/i.test(x)) ?? b[0]); }
    await w2.locator('#status:has-text("aved")').first().waitFor({ timeout: 15000 }).catch(() => {});
    await s.closeAllEditors();
    const o = await observe(s, mock, () => connectAction(s, 'TLS expired'));
    const text = summarise(o);
    if (o.toasts.some((t) => t.buttons.includes('Retry'))) throw new Error(`Retry is offered for a certificate error (confirms 1.1) :: ${text}`);
    if (o.toasts.some((t) => BARE.test(t.text))) throw new Error(`bare fallback text (confirms B1) :: ${text}`);
    return text;
  });
  await s.setSetting('filemaker.requestTimeoutMs', undefined);
}
