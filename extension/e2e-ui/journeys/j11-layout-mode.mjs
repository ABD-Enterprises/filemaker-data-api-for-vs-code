// Journey 11: FM Web project, Layout Mode and the preview server: open, confirmations (declined), what works at this commit.
import fs from 'node:fs';
import path from 'node:path';

import { answerPickers, connect, createProfile, ensureProfileCommands } from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J11 layout mode';
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory()
            ? e.name === 'node_modules'
              ? []
              : walk(path.join(dir, e.name))
            : [path.join(dir, e.name)]
        )
    : [];

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? ''))
    await connect(s, 'Mock Quality');

  await s.step(
    J,
    'Initialize FM Web Project',
    'toast; .fmweb folder with a project file appears in the workspace',
    async () => {
      await s.cmd('FileMaker: Initialize FM Web Project');
      const t = await s.waitToast(/Initialized FM Web project|FM Web/i, { timeout: 20000 });
      const files = walk(path.join(s.ws, '.fmweb')).map((f) => path.relative(s.ws, f));
      assert(files.length > 0, 'no .fmweb files');
      return `${t} | ${files.slice(0, 6).join(', ')}`;
    }
  );
  await s.step(
    J,
    'after Initialize, the other FM Web commands are offered',
    'Sync, Open Layout Mode, Generate and Start Preview appear in the palette without reloading the window',
    async () => {
      const ms = await s.waitCmdListed('FileMaker: Open FM Web Layout Mode', 10000);
      if (ms < 0) {
        await s.reloadWindow();
        const after = await s.waitCmdListed('FileMaker: Open FM Web Layout Mode', 8000);
        throw new Error(
          `not offered within 10 s of initialising the project; ${after >= 0 ? 'they appear only after a window reload' : 'not offered even after a reload'} (context key filemaker.fmWebProjectInitialized is refreshed only by Refresh Connections)`
        );
      }
      return `listed after ${ms} ms`;
    }
  );
  await s.step(
    J,
    'Sync FM Web Project Metadata',
    'metadata for the active profile is written under .fmweb',
    async () => {
      await s.cmd('FileMaker: Sync FM Web Project Metadata');
      await answerPickers(s, ['Mock Quality']);
      await s.page.waitForTimeout(5000);
      const toasts = await s.toasts();
      const files = walk(path.join(s.ws, '.fmweb')).map((f) => path.relative(s.ws, f));
      return `toasts: ${toasts.join(' || ') || 'none'} | files: ${files.length}`;
    }
  );
  await s.step(
    J,
    'Open FM Web Layout Mode',
    'a designer panel opens (webview) for a layout',
    async () => {
      await s.closeAllEditors();
      await s.cmd('FileMaker: Open FM Web Layout Mode');
      await answerPickers(s, ['Mock Quality', 'Customers'], { max: 3 });
      await s.page.waitForTimeout(5000);
      const tabs = await s.editorTabs();
      const frame = s.page.frames().find((f) => /fake\.html/.test(f.url()));
      const body = frame
        ? (
            await frame
              .locator('body')
              .innerText()
              .catch(() => '')
          )
            .replace(/\s+/g, ' ')
            .slice(0, 300)
        : '';
      const toasts = await s.toasts();
      assert(
        tabs.some((t) => /Layout/i.test(t)),
        `tabs: ${tabs.join(', ')}; toasts: ${toasts.join(' | ')}`
      );
      return `tabs: ${tabs.join(', ')} | panel text: ${body || '(empty)'}`;
    }
  );
  await s.step(
    J,
    'Generate FM Web Next.js App from the Marketplace build',
    'a plain message says what is missing; nothing half-written',
    async () => {
      await s.closeAllEditors();
      await s.dismissToasts();
      await s.cmd('FileMaker: Generate FM Web Next.js App');
      await s.page.waitForTimeout(5000);
      const files = walk(path.join(s.ws, '.fmweb', 'generated')).map((f) => path.relative(s.ws, f));
      const toasts = (await s.toasts()).join(' || ');
      assert(
        /not available in this installation/i.test(toasts) || files.length > 0,
        `neither generated nor explained: ${toasts}`
      );
      return `${files.length} generated files; toast: ${toasts.slice(0, 260)}`;
    }
  );
  await s.step(
    J,
    'Start FM Web Preview Server from the Marketplace build',
    'if the runtime ships it asks for the npm confirmation (decline); if not, it says so and runs nothing',
    async () => {
      await s.dismissToasts();
      await s.cmd('FileMaker: Start FM Web Preview Server');
      await s.page.waitForTimeout(4000);
      if (await s.modalVisible()) {
        const t = await s.modalText();
        assert(/npm install/.test(t) && /npm run dev/.test(t), t);
        await s.modal('Cancel');
        return `modal (declined): ${t.slice(0, 220)}`;
      }
      const toasts = (await s.toasts()).join(' || ');
      const terminals = await s.page.locator('.terminal-tab, .terminal-tabs-entry').count();
      const nm = fs.existsSync(
        path.join(s.ws, '.fmweb', 'generated', 'runtime-next', 'node_modules')
      );
      assert(
        !nm && terminals === 0,
        `a terminal or node_modules appeared without a confirmation (terminals ${terminals}, node_modules ${nm})`
      );
      assert(/not available|runtime/i.test(toasts), `no explanation: ${toasts}`);
      return `no modal; toast: ${toasts.slice(0, 260)}; terminals ${terminals}; node_modules ${nm}`;
    }
  );
  s.notTestable(
    J,
    'script-run confirmation from a layout file',
    'needs a layout definition with a script behaviour wired in the designer; the guard is covered by test/unit/layoutModeScriptGuard.test.ts, not driven through the UI here'
  );
  s.notTestable(
    J,
    'preview server actually started',
    'the confirmation was declined on purpose (npm install/dev would run package.json scripts from the workspace)'
  );
  await s.closeAllEditors();
}
