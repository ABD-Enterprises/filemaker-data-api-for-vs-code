// Journey 1: first run, getting-started walkthrough, workspace trust (Restricted Mode and trusted).
import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../lib/session.mjs';

const J = 'J01 first run';
export const ownsLaunch = true;
export async function run({ s }) {
  fs.writeFileSync(path.join(s.ws, 'README.md'), '# E2E workspace\n');
  // Variant A: VS Code asks about trust and the user chooses "Don't Trust" (Restricted Mode).
  s.welcome = true;
  s.writeSettings({
    'workbench.startupEditor': 'welcomePage',
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'always',
    'security.workspace.trust.banner': 'always'
  });
  await s.launch({ trusted: false });

  await s.step(
    J,
    'trust prompt appears for an untrusted folder',
    'a dialog asks whether to trust the authors of the folder',
    async () => {
      const text = await s.waitModal(20000);
      assert(/trust/i.test(text), `dialog text: ${text}`);
      return text.slice(0, 120);
    }
  );
  await s.step(
    J,
    'choose "No, I don\'t trust the authors"',
    'window enters Restricted Mode',
    async () => {
      const buttons = await s.modalButtons();
      const no = buttons.find((b) => /don'?t trust|no/i.test(b));
      assert(no, `buttons: ${buttons.join(', ')}`);
      await s.modal(no);
      await s.page.waitForTimeout(1500);
      const trusted = (await s.helper('ping')).trusted;
      assert(trusted === false, `workspace reported trusted=${trusted}`);
    }
  );

  await s.step(
    J,
    'extension is installed and active in Restricted Mode',
    'FileMaker items appear (status bar / activity bar)',
    async () => {
      const ext = (await s.helper('extensions')).find((e) =>
        /filemaker-data-api-tools/i.test(e.id)
      );
      assert(ext, 'extension not listed');
      return `${ext.id} ${ext.version} active=${ext.active}`;
    }
  );
  await s.step(
    J,
    'Welcome page lists the getting-started walkthrough',
    'the "Get started with FileMaker Data API Tools" walkthrough is offered',
    async () => {
      await s.cmd('Welcome: Open Walkthrough...');
      const items = await s.pickerItems();
      assert(
        items.some((i) => /Get started with FileMaker Data API Tools/i.test(i)),
        `walkthroughs: ${items.filter((i) => /FileMaker|Get started/i.test(i)).join(' | ') || items.slice(0, 5).join(' | ')}`
      );
      await s.pick('Get started with FileMaker Data API Tools');
      await s.page.waitForTimeout(1500);
    }
  );
  await s.step(
    J,
    'walkthrough shows its five steps',
    'steps: add profile, connect, query, inspect layout, generate types',
    async () => {
      const text = await s.page
        .locator(
          '.gettingStartedSlideDetails, .getting-started-category-container, .getting-started-detail-columns'
        )
        .first()
        .innerText();
      for (const t of [
        'Add a connection profile',
        'Connect and verify',
        'Run your first query',
        'Inspect a layout',
        'Generate typed code'
      ])
        assert(text.includes(t), `missing step "${t}"`);
    }
  );
  await s.step(
    J,
    'Restricted Mode gates risky commands',
    'Add Connection Profile (credentials) is refused or warns in an untrusted workspace',
    async () => {
      await s.closeAllEditors();
      await s.cmd('FileMaker: Add Connection Profile');
      await s.page.waitForTimeout(1500);
      const toasts = await s.toasts();
      const tabs = await s.editorTabs();
      return `toasts: ${toasts.join(' || ') || '(none)'}; tabs: ${tabs.join(', ')}`;
    }
  );

  // Variant B: trust the folder through the Restricted Mode banner command.
  await s.step(
    J,
    'trust the workspace from Restricted Mode',
    'workspace becomes trusted',
    async () => {
      await s.cmd('Workspaces: Manage Workspace Trust');
      await s.page.waitForTimeout(1200);
      const btn = s.page
        .locator('.workspace-trust-editor .monaco-button', { hasText: /Trust Folder|Trust/ })
        .first();
      await btn.click();
      await s.page.waitForTimeout(800);
      if (await s.modalVisible()) {
        const b = await s.modalButtons();
        await s.modal(b.find((x) => /trust/i.test(x) && !/don/i.test(x)) ?? b[0]);
      }
      await s.page.waitForTimeout(1500);
      assert((await s.helper('ping')).trusted === true, 'still untrusted');
    }
  );
  await s.closeAllEditors();
  s.welcome = false;
}
