// Journey 7: Script runner: run a script with a parameter, see result and error codes.
import { answerPickers, connect, createProfile, ensureProfileCommands } from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J07 script runner';
const text = async (wv, sel) =>
  (await wv.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? ''))
    await connect(s, 'Mock Quality');
  let wv;
  const runScript = async (name, param = '') => {
    await wv.locator('#scriptNameInput').fill(name);
    await wv.locator('#scriptParamInput').fill(param);
    const before = (await mock.log()).length;
    await wv.locator('#runButton').click();
    await wv
      .locator('#summary:not(:empty), #rawResult:not(:empty), #status:not(:empty)')
      .first()
      .waitFor({ timeout: 25000 });
    await s.page.waitForTimeout(2500);
    const requests = (await mock.log())
      .slice(before)
      .map((l) => `${l.method} ${l.path}${l.query ?? ''} -> ${l.status}/${l.code}`);
    return {
      summary: await text(wv, '#summary'),
      raw: await text(wv, '#rawResult'),
      status: await text(wv, '#status'),
      requests
    };
  };

  await s.step(
    J,
    'open the Script Runner',
    'panel opens; script field offers the database scripts',
    async () => {
      await s.closeAllEditors();
      await s.cmd('FileMaker: Open Script Runner');
      await answerPickers(s, ['Mock Quality', 'Customers']);
      if (await s.pickerOpen()) await s.inputBox('', { timeout: 10000 }); // optional record id: leave blank
      wv = await s.webview('#scriptNameInput');
      await wv
        .locator('#layoutSelect')
        .selectOption('Customers')
        .catch(() => {});
      const options = await wv
        .locator('#scriptNameInput')
        .evaluate((el) => (el.list ? [...el.list.options].map((o) => o.value) : []));
      return `script suggestions: ${options.join(', ') || '(none / free text)'}`;
    }
  );
  await s.step(
    J,
    'run Echo with a parameter',
    'result shows the parameter echoed back and error 0',
    async () => {
      const r = await runScript('Echo', 'hello world');
      assert(/hello world/.test(r.raw + r.summary), `raw: ${r.raw.slice(0, 200)}`);
      return `${r.requests.join(' ; ')} | summary: ${r.summary}`;
    }
  );
  await s.step(
    J,
    'a script run sends only the documented script request',
    'one GET /layouts/<layout>/script/<script>?script.param=... and no record read or find (Claris: "Run a script")',
    async () => {
      const r = await runScript('Echo', 'only the script');
      const sent = r.requests.filter((line) => !/\/sessions/.test(line));
      assert(
        sent.length === 1 && /^GET \/layouts\/Customers\/script\/Echo\?script\.param=only/.test(sent[0]),
        `requests: ${sent.join(' ; ')}`
      );
      assert(!sent.some((line) => /_find|\/records/.test(line)), `a record was read: ${sent.join(' ; ')}`);
      return sent.join(' ; ');
    }
  );
  await s.step(
    J,
    'script that returns an error code (Fail -> scriptError 3)',
    'the non-zero script error is visible, not reported as plain success',
    async () => {
      const r = await runScript('Fail');
      assert(
        /"?scriptError"?\s*:?\s*"?3/.test(r.raw) || /\b3\b/.test(r.summary),
        `raw: ${r.raw.slice(0, 200)} summary: ${r.summary}`
      );
      return `summary: ${r.summary} | status: ${r.status}`;
    }
  );
  await s.step(
    J,
    'script that does not exist (error 104)',
    'a readable error mentioning the missing script',
    async () => {
      const r = await runScript('No Such Script');
      assert(
        /104|missing|not found|Script/i.test(r.status + r.summary + r.raw),
        `${r.status} ${r.summary}`
      );
      return `status: ${r.status} | requests: ${r.requests.join(' ; ')}`;
    }
  );
  await s.step(J, 'slow script (1.5 s)', 'the UI shows progress and then the result', async () => {
    const r = await runScript('Slow');
    assert(/slow done/.test(r.raw), r.raw.slice(0, 120));
  });
  await s.step(
    J,
    'script with a 1 MB result',
    'the panel stays responsive and shows or truncates the result',
    async () => {
      const t0 = Date.now();
      const r = await runScript('Big Result');
      const ms = Date.now() - t0;
      assert(ms < 20000, `the panel took ${ms} ms to show a 1 MB result`);
      assert(
        r.raw.length > 0 || r.summary.length > 0 || r.status.length > 0,
        'nothing was shown for the 1 MB result'
      );
      assert(
        r.raw.length < 3 * 1024 * 1024,
        `the whole result is rendered (${r.raw.length} chars)`
      );
      return `rendered in ${ms} ms; raw length ${r.raw.length}; summary ${r.summary.slice(0, 80)}`;
    }
  );
  await s.step(
    J,
    'script parameter with a hostile string',
    'sent verbatim, shown as text (not interpreted)',
    async () => {
      const r = await runScript('Echo', '<img src=x onerror=alert(1)> "quoted" \\\\ ${x}');
      const html = await wv.locator('#rawResult').innerHTML();
      assert(!/<img/i.test(html.replace(/&lt;/g, '')), 'markup was injected into the page');
      return r.requests.join(' ; ');
    }
  );
  await s.step(
    J,
    'Copy as curl / fetch',
    'clipboard holds a request without the auth header unless asked',
    async () => {
      // Since 1.5 the formats live in the "Copy request" menu (a closed menu has no boxes to click).
      await wv.locator('#copyRequestMenu summary').click();
      await wv.getByRole('button', { name: 'Copy as curl', exact: true }).click();
      await s.page.waitForTimeout(800);
      const clip = await s.app.evaluate(({ clipboard }) => clipboard.readText());
      assert(/curl/.test(clip), clip.slice(0, 100));
      assert(!/Bearer [0-9a-f]{20}/i.test(clip), 'token present in curl text');
      return clip.replace(/\s+/g, ' ').slice(0, 220);
    }
  );
  await s.closeAllEditors();
}
