// Journey 13d: connecting to a server that presents FileMaker Server's DEFAULT certificate: a CN-only leaf
// ("Claris Self Signed Certificate (Not for Production Use)", no subjectAltName) issued by "Claris Root Authority",
// with only the leaf sent. Drives the wizard (Test Connection), the Custom CA file, the legacy allow-self-signed box and,
// where the build has it, the certificate pinning flow ("Review server certificate"). Run it against the base VSIX and
// against the PR #386 VSIX (E2E_VSIX=...) to compare.
import fs from 'node:fs';
import path from 'node:path';

import { startMock } from '../lib/mock.mjs';
import { connectAction, observe, summarise } from '../lib/observe.mjs';
import { createProfile, ensureProfileCommands } from '../lib/flows.mjs';

const J = 'J13d claris default cert';
const text = async (wv, sel) =>
  (
    await wv
      .locator(sel)
      .first()
      .innerText()
      .catch(() => '')
  )
    .replace(/\s+/g, ' ')
    .trim();

async function openWizard(s, { url, name = 'Claris server', ca = '', allow = false }) {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Add Connection Profile');
  const wv = await s.webview('#wizardForm');
  for (const [id, v] of Object.entries({
    profileName: name,
    serverUrl: url,
    database: 'Quality',
    username: 'tester',
    password: 'testpass1'
  }))
    await wv.locator(`#${id}`).fill(v);
  if (ca || allow) {
    if (!(await wv.locator('#certificateOptions').evaluate((el) => el.open)))
      await wv.locator('#certificateOptions summary').click();
    if (ca) await wv.locator('#caBundlePath').fill(ca);
    if (allow) await wv.locator('#allowSelfSigned').check();
  }
  return wv;
}
const buttons = async (wv) =>
  (await wv.locator('button, a.button, [role=button]').allInnerTexts())
    .map((b) => b.trim())
    .filter(Boolean);
/** Click Test Connection; a build with pinning shows a "Trust this certificate" modal instead of a plain failure. */
async function test(s, wv, { answer } = {}) {
  await wv.locator('#testBtn').click();
  let modal = null;
  for (let i = 0; i < 60; i += 1) {
    await s.page.waitForTimeout(500);
    if (await s.modalVisible()) {
      const mtext = await s.modalText();
      const mb = await s.modalButtons();
      modal = { text: mtext, buttons: mb };
      await s.shot('pin-modal');
      if (answer) {
        await s.modal(mb.find((b) => answer.test(b)) ?? mb[0]);
      } else {
        await s.modal(mb.find((b) => /cancel|no\b/i.test(b)) ?? mb[mb.length - 1]);
      }
      await s.page.waitForTimeout(1500);
      // a second modal (for example allow-expired) may follow
      if ((await s.modalVisible()) && answer) {
        const m2 = { text: await s.modalText(), buttons: await s.modalButtons() };
        modal.second = m2;
        await s.modal(m2.buttons.find((b) => answer.test(b)) ?? m2.buttons[0]);
        await s.page.waitForTimeout(1500);
      }
      break;
    }
    const st = await text(wv, '#status');
    if (st && !/Step \d of \d|Testing|Reaching/i.test(st)) break;
  }
  await s.page.waitForTimeout(1500);
  const status = await text(wv, '#status');
  return { status, modal };
}
const describeTest = (t) =>
  `status: "${t.status}"${t.modal ? ` | modal: ${t.modal.text.replace(/\s+/g, ' ').slice(0, 700)} | buttons: ${t.modal.buttons.join(' / ')}${t.modal.second ? ` | second modal: ${t.modal.second.text.replace(/\s+/g, ' ').slice(0, 300)} / ${t.modal.second.buttons.join(' / ')}` : ''}` : ''}`;

export async function run(ctx) {
  const { s, mock } = ctx;
  s.trustThrow = true; // these journeys judge by throwing a finding message
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  const claris = await startMock({ TLS: 'claris-default-cert' });
  (ctx.cleanups ??= []).push(() => claris.stop());
  const rootPem = claris.caPath;
  let wv;
  let hasPinning = false;

  await s.step(
    J,
    'Test Connection with no certificate options',
    "what the user sees for FileMaker Server's default certificate (private root, name mismatch, leaf only) and which remedies are offered",
    async () => {
      wv = await openWizard(s, { url: claris.baseUrl });
      const t = await test(s, wv);
      hasPinning = Boolean(
        t.modal && /trust this certificate/i.test(t.modal.text + t.modal.buttons.join(' '))
      );
      ctx.pinningBuild = hasPinning;
      return `${describeTest(t)} | pinning flow present: ${hasPinning} | wizard buttons: ${(await buttons(wv)).join(' / ')}`;
    }
  );
  await s.step(
    J,
    '(a) Custom CA certificate file = the Claris root PEM',
    'the chain verifies but the leaf name (CN only, no SAN) does not match the host: the message must say so',
    async () => {
      wv = await openWizard(s, { url: claris.baseUrl, ca: rootPem });
      const t = await test(s, wv);
      const all = `${t.status} ${t.modal?.text ?? ''}`;
      if (/uccess/i.test(t.status)) return `unexpectedly connected :: ${describeTest(t)}`;
      if (
        !/host|name|match|altnames|CN=|Names: \(none/i.test(all) ||
        (/^Failed to create FileMaker session\.?$/.test(t.status) && !t.modal)
      )
        throw new Error(
          `the root PEM alone still fails and nothing explains the hostname problem :: ${describeTest(t)}`
        );
      return describeTest(t);
    }
  );
  await s.step(
    J,
    '(c) legacy "Allow self-signed certificate (insecure)" box',
    'where the build still has it: accepted after a confirmation; what stays visible afterwards',
    async () => {
      wv = await openWizard(s, { url: claris.baseUrl, name: 'Claris legacy' });
      if (
        !(await wv.locator('#allowSelfSigned').count()) ||
        !(await wv
          .locator('#allowSelfSigned')
          .isVisible()
          .catch(() => false))
      ) {
        if (
          !(await wv
            .locator('#certificateOptions')
            .evaluate((el) => el.open)
            .catch(() => false))
        )
          await wv
            .locator('#certificateOptions summary')
            .click()
            .catch(() => {});
      }
      const visible = await wv
        .locator('#allowSelfSigned')
        .isVisible()
        .catch(() => false);
      if (!visible)
        return {
          result: 'NOTE',
          detail: `the legacy checkbox is not offered in this build. Certificate section text: ${await text(wv, '#certificateOptions')}`
        };
      await wv.locator('#allowSelfSigned').check();
      const t = await test(s, wv, { answer: /allow insecure|continue|allow|trust/i });
      await s.page.waitForTimeout(1000);
      await wv.locator('#saveBtn').click();
      await s.page.waitForTimeout(1500);
      if (await s.modalVisible()) {
        const b = await s.modalButtons();
        await s.modal(b.find((x) => /allow insecure|save|continue/i.test(x)) ?? b[0]);
      }
      await s.page.waitForTimeout(1500);
      await s.closeAllEditors();
      await s.openFileMakerSidebar();
      const rows = (await s.treeRows()).filter((r) => /Claris/.test(r));
      if (!/uccess|onnect/i.test(t.status))
        throw new Error(`did not connect :: ${describeTest(t)}`);
      return `${describeTest(t)} | Explorer row: ${rows.join(' | ')} | status bar: ${(await s.statusBar()).filter((x) => /insecure|certificate|TLS/i.test(x)).join(' | ') || '(no certificate warning)'}`;
    }
  );

  if (!hasPinning) {
    s.notTestable(
      J,
      '(b) pinning / "Trust this certificate" flow',
      'this build has no certificate pinning UI. Run with E2E_VSIX=<PR #386 VSIX> to drive it.'
    );
    s.notTestable(J, '(d) pin changed / pin expired', 'needs the pinning flow (PR #386)');
  } else {
    await s.step(
      J,
      '(b) decline the "Trust this certificate" modal',
      'declining pins nothing and the failure is explained',
      async () => {
        wv = await openWizard(s, { url: claris.baseUrl, name: 'Claris pinned' });
        const t = await test(s, wv);
        return describeTest(t);
      }
    );
    await s.step(
      J,
      '(b) accept: Trust this certificate, then Test, Save, Connect',
      'Test Connection succeeds after the pin; saving keeps it; Connect works; the Explorer shows the profile is pinned (not "insecure")',
      async () => {
        const t = await test(s, wv, { answer: /trust this certificate|trust/i });
        if (!/uccess|onnect/i.test(t.status))
          throw new Error(`after trusting, Test still fails :: ${describeTest(t)}`);
        await wv.locator('#saveBtn').click();
        await s.page.waitForTimeout(1500);
        if (await s.modalVisible()) {
          const b = await s.modalButtons();
          await s.modal(b.find((x) => /save|continue|trust/i.test(x)) ?? b[0]);
        }
        await s.page.waitForTimeout(1500);
        await s.closeAllEditors();
        const o = await observe(s, mock, () => connectAction(s, 'Claris pinned'));
        await s.openFileMakerSidebar();
        const rows = (await s.treeRows()).filter((r) => /Claris/.test(r));
        return `${describeTest(t)} | Connect: ${summarise(o)} | Explorer: ${rows.join(' | ')} | status bar: ${(await s.statusBar()).filter((x) => /pinned|insecure|certificate|FileMaker:/i.test(x)).join(' | ')}`;
      }
    );
    await s.step(
      J,
      '(d) the server certificate changes (same address, new certificate)',
      'Connect refuses and says the certificate changed',
      async () => {
        await s.cmd('FileMaker: Disconnect').catch(() => {});
        const port = new URL(claris.baseUrl).port;
        await claris.stop();
        const again = await startMock({ TLS: 'claris-default-cert', PORT: port });
        ctx.cleanups.push(() => again.stop());
        const o = await observe(s, mock, () => connectAction(s, 'Claris pinned'));
        const t = o.toasts.map((x) => x.text).join(' ');
        if (!/changed|different|pinned|fingerprint|certificate/i.test(t))
          throw new Error(`the changed certificate is not called out :: ${summarise(o)}`);
        return summarise(o);
      }
    );
    await s.step(
      J,
      '(d) pin an EXPIRED certificate',
      'the review dialog says it is expired and treats it separately',
      async () => {
        const expired = await startMock({ TLS: 'expired' });
        ctx.cleanups.push(() => expired.stop());
        wv = await openWizard(s, { url: expired.baseUrl, name: 'Pin expired' });
        const t = await test(s, wv);
        if (!t.modal)
          throw new Error(`no review dialog for an expired certificate :: ${describeTest(t)}`);
        if (!/expired/i.test(t.modal.text))
          throw new Error(
            `the dialog does not say the certificate is expired :: ${describeTest(t)}`
          );
        return describeTest(t);
      }
    );
  }
  await s.closeAllEditors();
}
