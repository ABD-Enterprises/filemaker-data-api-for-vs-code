// Journey 13a: failure modes: login failures and gateway/wire problems (docs/FILEMAKER_FAILURE_MODES.md, PR #384).
// Each scenario drives the real UI (Connect command, Query Builder) against the mock with a named fault and records what
// the user sees. A FAIL row confirms a "gap" hypothesis from the catalogue (the behaviour is not what it recommends).
import { startMock } from '../lib/mock.mjs';
import { connectAction, failedLogins, observe, summarise, toastInfo } from '../lib/observe.mjs';
import {
  answerPickers,
  createProfile,
  ensureProfileCommands,
  openQueryBuilder
} from '../lib/flows.mjs';

const J = 'J13a login+wire';
const RAW_JS = /Cannot read properties|undefined|TypeError|is not a function/i;

export async function run(ctx) {
  const { s, mock } = ctx;
  s.trustThrow = true; // these journeys judge by throwing a finding message
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  await s.setSetting('filemaker.requestTimeoutMs', 2500);
  await s.setSetting('filemaker.connect.backoffInitialMs', 300);
  await s.setSetting('filemaker.connect.backoffMaxMs', 1500);
  // The HTTP client reads requestTimeoutMs once at activation (extension.ts:177), so a reload is needed for it to apply.
  await s.reloadWindow();
  await ensureProfileCommands(s);
  const other = await startMock();
  (ctx.cleanups ??= []).push(() => other.stop());
  const fault = (f) => mock.admin('/__admin/fault', f);
  const clear = async () => {
    await mock.admin('/__admin/fault', { clear: true });
    await mock.admin('/__admin/reset-accounts').catch(() => {});
  };

  const scenario = async (name, expectText, setup, action, judge) => {
    await s.step(J, name, expectText, async () => {
      await s.cmd('FileMaker: Disconnect').catch(() => {});
      await s.dismissToasts().catch(() => {});
      await setup();
      const o = await observe(s, mock, action);
      await clear();
      const verdict = judge ? judge(o) : undefined;
      const detail = summarise(o);
      if (typeof verdict === 'string') throw new Error(`${verdict} :: ${detail}`);
      return detail;
    });
  };
  const connectNow = () => connectAction(s, 'Mock Quality');

  // ---- authentication -----------------------------------------------------------------------------
  await scenario(
    '2.1 bad password stored in the profile (server now rejects it)',
    'one clear 212 message, Edit Profile offered, one login attempt',
    async () => {
      await mock.admin('/__admin/account', { name: 'tester', password: 'changed-on-server' });
    },
    connectNow,
    (o) =>
      o.failedLogins > 1
        ? `Connect made ${o.failedLogins} failed logins for one action`
        : !o.toasts.some((t) => /212|password/i.test(t.text))
          ? 'no password message'
          : !o.toasts.some((t) => t.buttons.includes('Edit Profile'))
            ? 'no Edit Profile button'
            : undefined
  );
  await mock.admin('/__admin/account', { name: 'tester', password: 'testpass1' });

  await s.step(
    J,
    '2.2 password goes bad mid-session: five user actions (B4)',
    'at most one failed login in total; one clear message; then no automatic logins until the user acts',
    async () => {
      await clear();
      await connectNow();
      await s.waitToast(/onnected to/i, { timeout: 25000 });
      const wv = await openQueryBuilder(s, 'Customers');
      await mock.admin('/__admin/account', { name: 'tester', password: 'changed-on-server' });
      await mock.admin('/__admin/expire', {});
      const before = (await failedLogins(mock)).length;
      const outcomes = [];
      for (let i = 0; i < 5; i += 1) {
        await wv.locator('#jsonTab').click();
        await wv.locator('#findJson').fill(`[{"CustomerID":"C-000${i + 1}"}]`);
        await wv.locator('#runButton').click();
        await s.page.waitForTimeout(2500);
        outcomes.push(
          ((await wv.locator('#status').innerText()) || '').replace(/\s+/g, ' ').slice(0, 90)
        );
      }
      const failed = (await failedLogins(mock)).length - before;
      await mock.admin('/__admin/account', { name: 'tester', password: 'testpass1' });
      await s.closeAllEditors();
      if (failed > 1)
        throw new Error(
          `five user actions caused ${failed} failed logins (confirms B4). Messages: ${outcomes.join(' | ')}`
        );
      return `failed logins: ${failed}; messages: ${outcomes.join(' | ')}`;
    }
  );

  await scenario(
    '2.3 account inactive (210)',
    'friendly text, no retries',
    () => fault({ name: 'login-inactive', path: '/sessions' }),
    connectNow,
    (o) => (o.logins > 1 ? `Connect retried an inactive account ${o.logins - 1} times` : undefined)
  );
  await scenario(
    '2.4 password expired (211)',
    'friendly text, no retries',
    () => fault({ name: 'login-expired-password', path: '/sessions' }),
    connectNow,
    (o) => (o.logins > 1 ? `retried ${o.logins - 1} times` : undefined)
  );
  await scenario(
    '2.5 account locked (214)',
    'friendly text, no retries',
    () => fault({ name: 'login-locked', path: '/sessions' }),
    connectNow,
    (o) => (o.logins > 1 ? `retried ${o.logins - 1} times` : undefined)
  );
  await scenario(
    '2.8 no fmrest privilege (500 + 802)',
    'explains fmrest / closed file; does not retry',
    () => fault({ name: 'login-no-fmrest', path: '/sessions' }),
    connectNow,
    (o) =>
      o.logins > 1
        ? `Connect retried a business error ${o.logins - 1} times (confirms S2)`
        : !/fmrest|extended privilege|closed|hosted/i.test(o.toasts.map((t) => t.text).join(' '))
          ? 'message does not mention fmrest or a closed file (raw server text only)'
          : undefined
  );
  await scenario(
    '2.10 session limit (956) twice, then success',
    'retries with a visible countdown, then connects',
    () => fault({ name: 'login-session-limit', path: '/sessions', count: 2 }),
    connectNow,
    (o) =>
      !o.statusTrail.some((x) => /retry/i.test(x))
        ? 'no retry countdown in the status bar'
        : !o.toasts.some((t) => /onnected to/i.test(t.text))
          ? 'did not end connected'
          : undefined
  );
  await scenario(
    '4.16 HTTP 200 with messages[0].code 212 on login',
    'treated as a failed login',
    () => fault({ name: 'messages-nonzero-200', path: '/sessions', code: 212 }),
    connectNow,
    (o) =>
      o.toasts.some((t) => /onnected to/i.test(t.text))
        ? 'a 200 response carrying FileMaker error 212 was treated as a successful login (confirms 4.16)'
        : undefined
  );
  await scenario(
    '2.x database not hosted (500 + 100)',
    'message names the database',
    () => fault({ name: 'db-not-hosted', path: '/sessions' }),
    connectNow,
    (o) =>
      !/Quality|database|100/i.test(o.toasts.map((t) => t.text).join(' '))
        ? 'message does not mention the database'
        : undefined
  );

  // ---- gateway / wire ---------------------------------------------------------------------------------
  for (const f of ['html-200', 'empty-200', 'truncated-json', 'array-body', 'redirect-login']) {
    await scenario(
      `1.19 ${f} instead of the Data API envelope (login)`,
      'a plain-language "not the Data API / web page / redirect" message, never a JavaScript error',
      () => fault({ name: f, path: '/sessions' }),
      connectNow,
      (o) =>
        RAW_JS.test(o.toasts.map((t) => t.text).join(' '))
          ? 'raw JavaScript error shown to the user (confirms B3)'
          : undefined
    );
  }
  await scenario(
    '1.21 redirect to another origin (307)',
    'no session is minted at the other origin; the user is told about the redirect',
    () => fault({ name: 'redirect-other-origin', path: '/sessions', target: other.baseUrl }),
    connectNow,
    (o) => undefined
  );
  await s.step(
    J,
    '1.21b did the other origin receive a login?',
    'the other server must see no POST /sessions',
    async () => {
      const seen = (await other.log()).filter((l) => l.method === 'POST' && l.path === '/sessions');
      const gets = (await other.log()).length;
      if (seen.length)
        throw new Error(
          `the extension followed a cross-origin redirect and a login reached the other server (${seen.length} POST /sessions, status ${seen[0].status}) (confirms S4)`
        );
      return `other origin saw ${gets} requests, none a login`;
    }
  );
  for (const code of [413, 429, 502, 503, 504]) {
    await scenario(
      `1.22 HTTP ${code} from a gateway (login)`,
      code === 429 || code === 503
        ? 'retried after Retry-After; no HTML in the message'
        : 'gateway wording; 5xx retried with backoff',
      () => fault({ name: `status-${code}`, path: '/sessions' }),
      connectNow,
      (o) =>
        code === 429 && o.logins < 2
          ? '429 was not retried and Retry-After was ignored (confirms N2)'
          : /<html|<body|Sign in to continue|fm-gw-01/i.test(JSON.stringify(o.toasts))
            ? 'gateway HTML leaked into a visible message'
            : undefined
    );
  }
  await scenario(
    '1.17 slow server (response later than requestTimeoutMs=2.5 s)',
    'timed-out text that names the setting; Open Settings button',
    () => fault({ name: 'slow', path: '/sessions', delayMs: 8000 }),
    connectNow,
    (o) =>
      !o.toasts.some((t) => t.buttons.includes('Open Settings'))
        ? 'no Open Settings button'
        : !/requestTimeoutMs|setting/i.test(o.toasts.map((t) => t.text).join(' '))
          ? 'message does not name the setting (confirms the catalogue note)'
          : undefined
  );
  await scenario(
    '1.18 server drops the connection mid-response',
    'says the server closed the connection; never "(HTTP 200)"',
    () => fault({ name: 'drop-mid-response', path: '/sessions' }),
    connectNow,
    (o) =>
      /HTTP 200/.test(o.toasts.map((t) => t.text).join(' '))
        ? 'message says (HTTP 200) although no answer arrived (confirms 1.18)'
        : undefined
  );
  await scenario(
    '1.15-ish reset connection immediately',
    'readable network message',
    () => fault({ name: 'reset-connection', path: '/sessions' }),
    connectNow,
    (o) =>
      /^Failed to create FileMaker session\.?$/.test(o.toasts[0]?.text ?? '')
        ? 'bare fallback text only: no cause (confirms the catalogue)'
        : undefined
  );
  await scenario(
    '1.23 Data API turned off (HTML 404 on every path)',
    'points at the URL / base path / Data API setting',
    () => fault({ name: 'data-api-disabled' }),
    connectNow,
    (o) =>
      !/Data API|enabled|base path|Server URL/i.test(o.toasts.map((t) => t.text).join(' '))
        ? 'message is just the HTTP status (no hint that the Data API may be off)'
        : undefined
  );

  // ---- gap hypotheses on data calls ------------------------------------------------------------------------
  await s.step(
    J,
    '1.23b Data API off after connecting: layout metadata',
    'must not be reported as "Metadata is not supported on this server" and cached',
    async () => {
      await clear();
      await connectNow();
      await s.waitToast(/onnected to/i, { timeout: 25000 });
      await s.dismissToasts();
      await s.cmd('FileMaker: Refresh Schema Cache');
      await fault({ name: 'data-api-disabled', path: '/layouts/Customers' });
      await s.cmd('FileMaker: Select Layout for Inspector');
      await answerPickers(s, ['Mock Quality', 'Customers']);
      await s.page.waitForTimeout(3500);
      const body = (await s.page.locator('.pane-body').allInnerTexts())
        .join(' ')
        .replace(/\s+/g, ' ');
      const toasts = await toastInfo(s);
      await clear();
      await s.cmd('FileMaker: Select Layout for Inspector');
      await answerPickers(s, ['Mock Quality', 'Customers']);
      await s.page.waitForTimeout(3000);
      const after = (await s.page.locator('.pane-body').allInnerTexts())
        .join(' ')
        .replace(/\s+/g, ' ');
      if (/unavailable|not supported/i.test(body) && /unavailable|not supported/i.test(after))
        throw new Error(
          `a bare 404 became "metadata unavailable" and stayed cached after the server recovered (confirms S3). First: ${body.slice(0, 200)} | after recovery: ${after.slice(0, 200)}`
        );
      return `during: ${body.slice(0, 160)} | toasts ${toasts.map((t) => t.text).join('|')} | after recovery: ${after.slice(0, 120)}`;
    }
  );
  await s.step(
    J,
    '2.17/1.19b HTML 200 on a data call (Explorer expand)',
    'a plain message in the Explorer (not just a generic placeholder), no JS error',
    async () => {
      await s.cmd('FileMaker: Refresh Schema Cache');
      await fault({ name: 'html-200', path: '/layouts$' });
      await s.openFileMakerSidebar();
      await s.page
        .locator('.pane-header .actions .codicon-refresh')
        .first()
        .click({ force: true })
        .catch(() =>
          s.helper('executeCommand', { command: 'filemakerDataApiTools.refreshExplorer' })
        );
      await s.page.waitForTimeout(3500);
      const rows = await s.allTreeRows();
      const toasts = await toastInfo(s);
      await clear();
      const placeholder = rows.find((r) => /Failed to load layouts/i.test(r));
      const msg = `rows: ${rows.slice(0, 5).join(' | ')} | toasts: ${toasts.map((t) => t.text).join('|') || 'none'}`;
      if (
        placeholder &&
        !/web page|not the Data API|HTML|proxy/i.test(placeholder + JSON.stringify(toasts))
      )
        throw new Error(
          `Explorer shows only "${placeholder}"; the cause is only in the Output channel (confirms S6). ${msg}`
        );
      return msg;
    }
  );
  await s.step(
    J,
    '3.2/S13 find with no match answered as HTTP 500 + code 401',
    'treated as an empty result, not an error',
    async () => {
      await clear();
      const wv = await openQueryBuilder(s, 'Customers');
      await fault({ name: 'find-no-match-500', path: '/_find' });
      await wv.locator('#jsonTab').click();
      await wv.locator('#findJson').fill('[{"LastName":"zzzz-nothing"}]');
      await wv.locator('#runButton').click();
      await s.page.waitForTimeout(2500);
      const st = (
        (await wv.locator('#status').innerText()) +
        ' | ' +
        (await wv.locator('#resultSummary').innerText())
      ).replace(/\s+/g, ' ');
      await clear();
      await s.closeAllEditors();
      if (/error|HTTP 500|failed/i.test(st))
        throw new Error(`a no-match answered 500/401 is shown as an error (confirms S13): ${st}`);
      return st;
    }
  );
  await s.step(
    J,
    '2.x second session left alive by the proactive refresh (N3)',
    'at most one live session after a refresh',
    async () => {
      await s.setSetting('filemaker.session.maxAgeMinutes', 1);
      await s.setSetting('filemaker.session.refreshLeadSeconds', 30);
      await s.cmd('FileMaker: Disconnect').catch(() => {});
      await mock.admin('/__admin/expire', {});
      await connectNow();
      await s.waitToast(/onnected to/i, { timeout: 25000 });
      const wv = await openQueryBuilder(s, 'Customers');
      for (let i = 0; i < 6; i += 1) {
        await wv.locator('#runButton').click();
        await s.page.waitForTimeout(8000);
      }
      const state = await mock.admin('/__admin/state');
      await s.setSetting('filemaker.session.maxAgeMinutes', undefined);
      await s.closeAllEditors();
      const mine = state.liveSessions.filter((x) => x.user === 'tester' && x.db === 'Quality');
      if (mine.length > 1)
        throw new Error(
          `${mine.length} live sessions for one profile after about 50 s of use with a 1-minute refresh (confirms N3): ages ${mine.map((x) => Math.round(x.ageMs / 1000) + 's').join(', ')}`
        );
      return `live sessions: ${mine.length}`;
    }
  );
  await s.setSetting('filemaker.requestTimeoutMs', undefined);
  await s.setSetting('filemaker.connect.backoffInitialMs', undefined);
  await s.setSetting('filemaker.connect.backoffMaxMs', undefined);
}
