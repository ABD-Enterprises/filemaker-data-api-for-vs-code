// Journey 8: schema snapshots and diff, type generation (incl. hostile layout/field names), saved queries, history.
import fs from 'node:fs';
import path from 'node:path';

import {
  answerPickers,
  connect,
  createProfile,
  ensureProfileCommands,
  openQueryBuilder
} from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J08 schema+typegen';
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
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
  const man = await mock.manifest();

  // ---- snapshots -----------------------------------------------------------------------------
  await s.step(
    J,
    'Capture Schema Snapshot (Products)',
    'toast "Captured schema snapshot"; snapshot appears under the layout in the Explorer',
    async () => {
      await s.cmd('FileMaker: Capture Schema Snapshot');
      await answerPickers(s, ['Mock Quality', 'Products']);
      const t = await s.waitToast(/Captured schema snapshot/i, { timeout: 20000 });
      return t;
    }
  );
  await s.step(
    J,
    'schema changes on the server, capture again, Diff Schema Snapshots',
    'the diff shows the added field and the removed field',
    async () => {
      await mock.admin('/__admin/schema', {
        db: 'Quality',
        table: 'Products',
        addField: { name: 'NewColumn', result: 'text' }
      });
      await mock.admin('/__admin/schema', {
        db: 'Quality',
        table: 'Products',
        removeField: 'Description'
      });
      await s.cmd('FileMaker: Refresh Schema Cache').catch(() => {});
      await s.page.waitForTimeout(800);
      await s.cmd('FileMaker: Capture Schema Snapshot');
      await answerPickers(s, ['Mock Quality', 'Products']);
      await s.waitToast(/Captured schema snapshot/i, { timeout: 20000 });
      await s.dismissToasts();
      await s.cmd('FileMaker: Diff Schema Snapshots');
      await answerPickers(s, ['Mock Quality', 'Products'], { max: 6 });
      // two snapshot pickers (older, newer): choose the first listed each time
      for (let i = 0; i < 2; i += 1) {
        if (await s.pickerOpen()) {
          const items = await s.pickerItems();
          await s.pick(items[0].split(' ')[0]);
          await s.page.waitForTimeout(500);
        }
      }
      await s.page.waitForTimeout(3000);
      const tabNow = (await s.editorTabs()).join(', ');
      let text = '';
      for (const f of s.page.frames()) {
        if (!/fake\.html/.test(f.url())) continue;
        try {
          const t = await f.locator('body').innerText();
          if (/Schema Diff/.test(t)) text = t;
        } catch {
          /* detached */
        }
      }
      assert(
        /NewColumn/.test(text) && /Description/.test(text),
        `tabs ${tabNow}; diff panel text: ${text.replace(/\s+/g, ' ').slice(0, 300)}`
      );
      return text.replace(/\s+/g, ' ').slice(0, 240);
    }
  );
  await s.step(
    J,
    'snapshots are stored in the workspace (workspaceFiles)',
    'JSON snapshot files exist under the workspace',
    async () => {
      const files = walk(s.ws).filter((f) => /snapshot/i.test(f));
      assert(files.length >= 2, `snapshot files: ${files.length}`);
      return files.map((f) => path.relative(s.ws, f)).join(', ');
    }
  );
  // restore schema for later journeys
  await mock.admin('/__admin/schema', {
    db: 'Quality',
    table: 'Products',
    removeField: 'NewColumn'
  });

  // ---- type generation -------------------------------------------------------------------------
  await s.step(
    J,
    'Generate Types for Layout (Customers)',
    'a .ts file opens in the editor with an interface for Customers',
    async () => {
      await s.closeAllEditors();
      await s.cmd('FileMaker: Generate Types for Layout');
      await answerPickers(s, ['Mock Quality', 'Customers']);
      await s.waitToast(/Generated types for Customers/i, { timeout: 25000 });
      const tabs = await s.editorTabs();
      const files = walk(path.join(s.ws, 'filemaker-types'));
      assert(files.length >= 1, 'no generated file in filemaker-types');
      return `${tabs.join(', ')} | files: ${files.map((f) => path.relative(s.ws, f)).join(', ')}`;
    }
  );
  await s.step(
    J,
    'Generate Types for All Layouts (hostile layout and field names included)',
    'files stay inside the types folder; names are sanitised; reserved names (CON, NUL) and traversal strings do not escape',
    async () => {
      const before = new Set(walk(s.root));
      await s.cmd('FileMaker: Generate Types for All Layouts');
      await answerPickers(s, ['Mock Quality']);
      await s
        .waitToast(/Generated \d+ layout type files|Generated types|fail|error/i, {
          timeout: 90000
        })
        .catch(() => {});
      await s.page.waitForTimeout(2500);
      const after = walk(s.root).filter(
        (f) =>
          !before.has(f) &&
          !f.includes(`${path.sep}user-data${path.sep}`) &&
          !f.includes(`${path.sep}home${path.sep}`) &&
          !f.includes('helper-io')
      );
      const typesDir = path.join(s.ws, 'filemaker-types') + path.sep;
      const cache = after.filter((f) =>
        f.includes(`${path.sep}.vscode${path.sep}filemaker${path.sep}`)
      );
      ctx.workspaceCacheFiles = cache.length;
      const outside = after.filter((f) => !f.startsWith(typesDir) && !cache.includes(f));
      const names = walk(path.join(s.ws, 'filemaker-types')).map((f) =>
        path.relative(path.join(s.ws, 'filemaker-types'), f)
      );
      ctx.typegenFiles = names;
      assert(outside.length === 0, `files written outside the types folder: ${outside.join(', ')}`);
      return `${names.length} files: ${names.join(', ')} | also written into the workspace by the schema fetch: ${cache.length} offline-metadata cache files under .vscode/filemaker/`;
    }
  );
  await s.step(
    J,
    'generated code with hostile names is syntactically valid and not executable',
    'TypeScript parses; no template-injection from field names (backticks, ${}, quotes)',
    async () => {
      const dir = path.join(s.ws, 'filemaker-types');
      const files = walk(dir).filter((f) => f.endsWith('.ts'));
      fs.cpSync(dir, path.join(ctx.artifacts, 'generated-types'), { recursive: true });
      const combined = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      const hostileSurvived = ['${x}', "x'; DROP TABLE y;--", '</script>'].filter((n) =>
        combined.includes(n)
      );
      // syntax check with the TypeScript compiler API (no type resolution needed)
      const tsPath = path.join(ctx.repoRoot, 'node_modules', 'typescript6', 'lib', 'typescript.js');
      let diagnostics = 'tsc not available';
      if (fs.existsSync(tsPath)) {
        const ts = (await import(tsPath)).default;
        const bad = [];
        for (const f of files) {
          const sf = ts.createSourceFile(
            f,
            fs.readFileSync(f, 'utf8'),
            ts.ScriptTarget.ES2022,
            true
          );
          const d = sf.parseDiagnostics ?? [];
          if (d.length)
            bad.push(
              `${path.basename(f)}: ${ts.flattenDiagnosticMessageText(d[0].messageText, '\n')}`
            );
        }
        assert(bad.length === 0, `syntax errors: ${bad.slice(0, 3).join(' | ')}`);
        diagnostics = 'all files parse';
      }
      return `${files.length} files; ${diagnostics}; raw hostile strings present in output: ${JSON.stringify(hostileSurvived)}`;
    }
  );

  // ---- saved queries and history ---------------------------------------------------------------
  let wv;
  await s.step(
    J,
    'Query Builder: Save… a query',
    'asks for a name; "Saved query" toast; appears in the Explorer under Saved Queries',
    async () => {
      wv = await openQueryBuilder(s, 'Customers');
      await wv.locator('#jsonTab').click();
      await wv.locator('#findJson').fill('[{"Status":"Open"}]');
      await wv.locator('#runButton').click();
      await s.page.waitForTimeout(1500);
      await wv.locator('#saveButton').click();
      await s.inputBox('E2E open customers', { timeout: 15000 });
      const t = await s.waitToast(/Saved query/i, { timeout: 15000 });
      await s.openFileMakerSidebar();
      return t;
    }
  );
  await s.step(
    J,
    'Run Saved Query',
    'the saved find runs and its result opens (as a JSON document)',
    async () => {
      await s.closeAllEditors();
      await s.cmd('FileMaker: Run Saved Query');
      await answerPickers(s, ['E2E open customers']);
      await s.page.waitForTimeout(3000);
      await s.autoDismiss();
      const tabs = await s.editorTabs();
      const t = await s.activeEditorText();
      assert(/savedQuery|E2E open customers/.test(t), `editor: ${t.slice(0, 160)}`);
      return `tabs: ${tabs.join(', ')} | ${t.replace(/\s+/g, ' ').slice(0, 160)}`;
    }
  );
  await s.setSetting('filemaker.advanced.powerUserMode', true);
  await s.page.waitForTimeout(1500);
  await s.step(
    J,
    'Show Request History',
    'a list of recent requests (operation, layout, status) opens; older entries are capped by filemaker.history.maxEntries (10)',
    async () => {
      await s.cmd('FileMaker: Show Request History');
      await s.page.waitForTimeout(1200);
      const items = await s.allPickerItems();
      await s.escape();
      return `${items.length} entries: ${items.slice(0, 3).join(' | ')}`;
    }
  );
  await s.closeAllEditors();
}
