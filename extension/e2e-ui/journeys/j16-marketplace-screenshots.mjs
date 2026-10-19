// Journey 16: the screenshots for the Marketplace page and the README (extension/docs/marketplace/).
//
// Not a test: it asserts almost nothing and is skipped unless you ask for it, so a full `npm run test:e2e-ui` does not
// run it. Run it with
//   E2E_MARKETPLACE=1 E2E_ONLY=j16 E2E_SHOTS_DIR=<folder> npm run test:e2e-ui
// It drives the real VS Code against the mock Data API (database Sales, layout Contacts: 157 made-up people with
// example.com addresses) and writes one PNG per feature into E2E_SHOTS_DIR (default: <artifacts>/marketplace).
// The window is 1360 x 850 so the text stays readable when the Marketplace scales the image down. The chat screenshot
// uses the harness's stand-in language model (see j10c), never a real model; only the participant's own output shows.
import fs from 'node:fs';
import path from 'node:path';

import { answerPickers, connect, createProfile, ensureProfileCommands } from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J16 marketplace screenshots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(ctx) {
  if (process.env.E2E_MARKETPLACE !== '1') {
    console.log('J16 skipped: set E2E_MARKETPLACE=1 to capture the Marketplace screenshots');
    return;
  }
  const { s, mock, artifacts } = ctx;
  const out = path.resolve(process.env.E2E_SHOTS_DIR ?? path.join(artifacts, 'marketplace'));
  fs.mkdirSync(out, { recursive: true });
  const shoot = async (name) => {
    await s.dismissToasts().catch(() => {});
    await sleep(500);
    await s.page.screenshot({ path: path.join(out, `${name}.png`), scale: 'css' });
    console.log(`  captured ${name}.png`);
  };
  // A native title bar keeps the window title, the account button and the layout controls out of the picture.
  s.writeSettings({ 'window.titleBarStyle': 'native', 'window.customTitleBarVisibility': 'never' });
  await s.restart({ size: [1360, 940] });
  const sidebarWidth = async (px) => {
    const sash = s.page.locator('.monaco-sash.vertical').first();
    const box = await sash.boundingBox();
    if (box) {
      await s.page.mouse.move(box.x + box.width / 2, box.y + 200);
      await s.page.mouse.down();
      await s.page.mouse.move(px, box.y + 200, { steps: 8 });
      await s.page.mouse.up();
    }
  };
  const clickAway = async () => {
    await s.page.mouse.move(900, 500);
  };
  const resize = async (height) => {
    await s.app.evaluate(({ BrowserWindow }, h) => {
      BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 40, width: 1360, height: h });
    }, height);
    await sleep(800);
  };

  // 1. Connection setup: the form with made-up values, before anything is tested or saved.
  await s.step(J, 'connection setup', 'wizard filled with example values', async () => {
    await s.closeAllEditors();
    await s.openFileMakerSidebar();
    await resize(1020);
    await s.cmd('FileMaker: Add Connection Profile');
    const wv = await s.webview('#wizardForm');
    for (const [id, v] of Object.entries({
      profileName: 'Sales (staging)',
      serverUrl: 'https://fms.example.com',
      database: 'Sales',
      username: 'api-reader',
      password: 'not-a-real-password'
    }))
      await wv.locator(`#${id}`).fill(v);
    await wv.locator('body').evaluate(() => window.scrollTo(0, 0));
    await sleep(600);
    await shoot('connection-setup');
    assert(true);
  });
  await s.closeAllEditors();
  await resize(940);
  await createProfile(s, { name: 'Sales (demo)', url: mock.baseUrl, database: 'Sales' });
  await ensureProfileCommands(s);
  await connect(s, 'Sales (demo)');

  // 2. Explorer: connection, layouts, the fields of one layout, and the Layout Inspector filled.
  await s.step(J, 'explorer', 'sidebar with layouts and fields', async () => {
    await s.openFileMakerSidebar();
    await sidebarWidth(400);
    const row = (label) =>
      s.page.locator('.pane-body .monaco-list-row', { hasText: label }).first();
    const open = async (label) => {
      const r = row(label);
      await r.waitFor({ state: 'visible', timeout: 10000 });
      if ((await r.getAttribute('aria-expanded')) !== 'true')
        await r.locator('.monaco-tl-twistie').first().click();
      await sleep(1200);
    };
    await open('Sales (demo)');
    await open('Contacts');
    await open('Fields');
    await s.cmd('FileMaker: Select Layout for Inspector');
    await answerPickers(s, ['Sales (demo)', 'Contacts'], { max: 3 });
    await sleep(2500);
    await row('Value Lists').click({ position: { x: 150, y: 10 } }).catch(() => {});
    await s.page.mouse.click(900, 600);
    await clickAway();
    await sleep(500);
    // Only the sidebar: the editor next to it is empty here.
    const size = await s.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await s.page.screenshot({
      path: path.join(out, 'explorer.png'),
      scale: 'css',
      clip: { x: 0, y: 0, width: 352, height: size.height - 24 }
    });
    console.log('  captured explorer.png');
    assert(true);
  });

  // 3 and 4. Query Builder with results, and its Copy request menu.
  let wv;
  await s.step(J, 'query builder', 'a find with results', async () => {
    await s.closeAllEditors();
    await s.cmd('FileMaker: Open Query Builder');
    await answerPickers(s, ['Sales (demo)', 'Contacts']);
    wv = await s.webview('#runButton');
    await wv.locator('#layoutSelect').selectOption('Contacts').catch(() => {});
    await wv.locator('#jsonTab').click();
    await wv.locator('#findJson').fill('[{"Status":"Open","Region":"East"}]');
    await wv.locator('#sortJson').fill('[{"fieldName":"LastName","sortOrder":"ascend"}]');
    await wv.locator('#limitInput').fill('25');
    await wv.locator('#runButton').click();
    await wv.locator('#resultSummary:not(:empty)').first().waitFor({ timeout: 20000 });
    await sleep(1500);
    await clickAway();
    await shoot('query-builder');
    assert(true);
  });
  await s.step(J, 'copy as code', 'the Copy request menu open', async () => {
    await wv.locator('#copyRequestMenu summary').click();
    await sleep(700);
    await shoot('copy-as-code');
    await wv.locator('#copyRequestMenu summary').click();
    assert(true);
  });

  // 5. Record Editor.
  await s.step(J, 'record editor', 'a record loaded for editing', async () => {
    await s.closeAllEditors();
    await s.cmd('FileMaker: Open Record Editor');
    await answerPickers(s, ['Sales (demo)', 'Contacts']);
    if (await s.pickerOpen()) await s.inputBox('1003', { timeout: 10000 });
    const ed = await s.webview('#recordIdInput');
    await ed.locator('#layoutSelect').selectOption('Contacts').catch(() => {});
    if (!(await ed.locator('#fieldEditor textarea').count())) {
      await ed.locator('#recordIdInput').fill('1003');
      await ed.locator('#loadButton').click();
    }
    await ed.locator('#fieldEditor textarea').first().waitFor({ timeout: 20000 });
    await sleep(1200);
    await clickAway();
    await shoot('record-editor');
    assert(true);
  });

  // 6. Layout Mode, with a few fields placed on the canvas.
  await s.step(J, 'layout mode', 'the layout designer with fields on the canvas', async () => {
    await s.closeAllEditors();
    await s.cmd('FileMaker: Initialize FM Web Project');
    await s.waitToast(/FM Web/i, { timeout: 20000 }).catch(() => {});
    await s.cmd('FileMaker: Sync FM Web Project Metadata');
    await answerPickers(s, ['Sales (demo)']);
    await sleep(5000);
    await s.dismissToasts();
    await s.cmd('FileMaker: Open FM Web Layout Mode');
    await answerPickers(s, ['Sales (demo)', 'Contacts'], { max: 3 });
    await sleep(5000);
    const dw = await s.webview('.canvas-scroll');
    const canvas = dw.locator('.canvas-scroll').first();
    const placed = [
      ['FirstName', 30, 30],
      ['LastName', 250, 30],
      ['Email', 30, 90],
      ['Status', 250, 90],
      ['Region', 30, 150],
      ['Amount', 250, 150]
    ];
    for (const [name, x, y] of placed) {
      await dw
        .locator('.field-chip', { hasText: new RegExp(`^${name}$`) })
        .first()
        .dragTo(canvas, { targetPosition: { x, y } });
      await sleep(400);
    }
    await canvas.click({ position: { x: 420, y: 330 }, force: true, timeout: 5000 }).catch(() => {});
    await sleep(1200);
    await clickAway();
    await shoot('layout-mode');
    assert(true);
  });

  // 7. About / Show Version: the notification is the whole feature, so keep it and crop to the lower right.
  await s.step(J, 'about', 'About / Show Version', async () => {
    await s.closeAllEditors();
    await s.dismissToasts();
    await s.cmd('FileMaker: About / Show Version');
    await sleep(2500);
    await clickAway();
    const size = await s.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await s.page.screenshot({
      path: path.join(out, 'about.png'),
      scale: 'css',
      clip: { x: size.width - 760, y: size.height - 230, width: 760, height: 230 }
    });
    console.log('  captured about.png');
    assert(true);
  });
  await s.escape(2);
  await s.dismissToasts().catch(() => {});

  // 8. @filemaker in the Chat view (stand-in language model; the answer comes from the participant and the tools).
  await s.step(J, 'chat', '@filemaker answering /find', async () => {
    await s.cmd('FileMaker: Open Query Builder');
    await answerPickers(s, ['Sales (demo)', 'Contacts']);
    await s.webview('#runButton');
    await s.setSetting('filemaker.ai.enabled', true);
    await s.cmd('FileMaker: Set AI Access for Connection');
    await answerPickers(s, ['Sales (demo)'], { max: 1 });
    await s.pick('Read');
    await s.clickToastButton('Use for AI Tools').catch(() => {});
    await sleep(1500);
    await s.helper('executeCommand', { command: 'workbench.action.chat.newChat' }).catch(() => {});
    await s.helper('executeCommand', {
      command: 'workbench.action.chat.open',
      args: [
        {
          query: '@filemaker /find Contacts Region=East',
          modelSelector: { vendor: 'fme2e', id: 'fm-e2e-model' },
          mode: 'ask'
        }
      ]
    });
    await sleep(2500);
    if (await s.modalVisible()) {
      const buttons = await s.modalButtons();
      console.log(`  modal buttons: ${buttons.join(' / ')}`);
      await s.modal(buttons.find((b) => /allow|approve|yes|read|ok/i.test(b)) ?? buttons[0]);
    }
    await sleep(6000);
    await clickAway();
    await shoot('chat-participant');
    assert(true);
  });

  // 9. Schema diff: a snapshot, the server changes (a field added, one removed), then the diff of the live layout against it.
  await s.step(J, 'schema diff', 'live layout compared with a snapshot', async () => {
    await s.escape(2);
    await s.helper('executeCommand', { command: 'workbench.action.closeAuxiliaryBar' }).catch(() => {});
    await s.closeAllEditors();
    await s.cmd('FileMaker: Capture Schema Snapshot');
    await answerPickers(s, ['Sales (demo)', 'Contacts']);
    await s.waitToast(/Captured schema snapshot/i, { timeout: 20000 });
    await s.dismissToasts();
    await mock.admin('/__admin/schema', {
      db: 'Sales',
      table: 'Contacts',
      addField: { name: 'Phone', result: 'text' }
    });
    await mock.admin('/__admin/schema', { db: 'Sales', table: 'Contacts', removeField: 'Notes' });
    await s.cmd('FileMaker: Refresh Schema Cache').catch(() => {});
    await sleep(800);
    await s.cmd('FileMaker: Diff Against Latest Snapshot');
    await answerPickers(s, ['Sales (demo)', 'Contacts'], { max: 2 });
    await sleep(3500);
    const diff = await s.webview('text=Show only changes');
    await diff.locator('input[type=checkbox]').first().check();
    await sleep(800);
    await clickAway();
    await shoot('schema-diff');
    await mock.admin('/__admin/schema', { db: 'Sales', table: 'Contacts', removeField: 'Phone' });
    assert(true);
  });
}
