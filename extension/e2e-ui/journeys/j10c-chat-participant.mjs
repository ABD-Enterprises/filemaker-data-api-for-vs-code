// Journey 10c: the @filemaker chat participant in the real Chat view (ADR-0005).
//
// The Copilot model is not available here, so the helper extension registers a deterministic fake language model
// (vscode.lm.registerLanguageModelChatProvider, stable since VS Code 1.104) and the chat is pointed at it. That tests
// the participant, the Chat UI, the real tool core and the rendering. It does NOT test how a real model behaves.
import { answerPickers, connect, createProfile, ensureProfileCommands } from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J10c chat participant';
const MODEL = { vendor: 'fme2e', id: 'fm-e2e-model' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chatText = (s) =>
  s.page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll('.interactive-session .monaco-list-row.response')
    ].filter((row) => row.getBoundingClientRect().height > 0);
    return (rows.at(-1)?.innerText ?? '').replace(/\u00a0/g, ' '); // Monaco code blocks use no-break spaces
  });

/** What the last response contains that could act: links, images, buttons, and where they point. */
const responseParts = (s) =>
  s.page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll('.interactive-session .monaco-list-row.response')
    ].filter((row) => row.getBoundingClientRect().height > 0);
    const last = rows.at(-1);
    if (!last) return { links: [], images: [], buttons: [], codeBlocks: 0, text: '' };
    const body = [...last.querySelectorAll('.chat-markdown-part')];
    return {
      links: body.flatMap((part) =>
        [...part.querySelectorAll('a')].map(
          (a) => a.getAttribute('data-href') ?? a.getAttribute('href') ?? a.innerText
        )
      ),
      images: [...last.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? ''),
      buttons: [
        ...last.querySelectorAll(
          '.chat-command-button *, a.monaco-button, button.monaco-button, .monaco-button'
        )
      ]
        .map((b) => b.innerText.trim())
        .filter(Boolean),
      codeBlocks: last.querySelectorAll('.interactive-result-code-block').length,
      text: last.innerText.replace(/\u00a0/g, ' ')
    };
  });

/** Ask in a new chat; answer a host modal if one appears; wait until the response stops changing. */
async function ask(s, query, { answer, timeout = 45000 } = {}) {
  await s.escape(2);
  await s.helper('executeCommand', { command: 'workbench.action.chat.newChat' }).catch(() => {});
  for (let i = 0; i < 20 && (await chatText(s)) !== ''; i += 1) await sleep(250); // the old answer is gone
  await s.helper('executeCommand', {
    command: 'workbench.action.chat.open',
    args: [{ query, modelSelector: MODEL, mode: 'ask' }]
  });
  let modal;
  if (answer !== undefined) {
    modal = await s.waitModal(20000);
    const buttons = await s.modalButtons();
    await s.shot(`modal-${query.slice(0, 20)}`);
    if (answer) await s.modal(buttons.find((b) => new RegExp(answer, 'i').test(b)) ?? buttons[0]);
    else await s.modal(buttons.find((b) => /cancel|don'?t|no\b/i.test(b)) ?? 'Cancel');
  }
  // The list is virtualised: keep the longest text seen for the last response, and stop when it has not grown for 3 seconds.
  let best = '';
  let stable = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const text = await chatText(s);
    const body = text.replace(/^\s*FileMaker\s*/, '').trim();
    if (body.length > 0 && !/Asking the language model/.test(text) && text.length >= best.length) {
      stable = text === best ? stable + 1 : 0;
      best = text;
    }
    if (best && stable >= 6) break;
    await sleep(500);
  }
  const parts = await responseParts(s);
  return { ...parts, text: best.length >= parts.text.length ? best : parts.text, modal };
}

async function clickResponseButton(s, label) {
  const button = s.page
    .locator('.interactive-session .monaco-list-row.response')
    .last()
    .locator('.monaco-button', { hasText: label })
    .first();
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ timeout: 10000 });
}

const noActiveContent = (parts) => {
  const bad = parts.links.filter((l) => /^(command|javascript|data|file|vscode):/i.test(l));
  return { bad, images: parts.images };
};

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? ''))
    await connect(s, 'Mock Quality');
  await s.escape(2);
  await s.setSetting('filemaker.ai.enabled', false);
  await s.setSetting('filemaker.ai.hiddenFields', ['SSN', 'Password', 'Token']);
  const modelLog = async () =>
    (await s.helper('readFile', { name: 'model-log.jsonl' })).text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  await s.step(
    J,
    'AI off: @filemaker says how to turn AI on, with a button to the setting',
    'a short "AI tools are off" answer with steps and an Open AI Settings button; nothing is read from the server',
    async () => {
      const before = (await mock.log()).length;
      const r = await ask(s, '@filemaker /layouts');
      assert(/AI tools are off/.test(r.text), r.text.slice(0, 300));
      assert(
        /filemaker\.ai\.enabled/.test(r.text) && /Set AI Access/.test(r.text),
        'no steps in the answer'
      );
      assert(
        r.buttons.some((b) => /Open AI Settings/.test(b)),
        `buttons: ${JSON.stringify(r.buttons)}`
      );
      const reads = (await mock.log()).slice(before).filter((l) => l.path.includes('/layouts'));
      assert(reads.length === 0, `server was read while AI was off: ${reads.length} requests`);
      await clickResponseButton(s, 'Open AI Settings');
      await s.page.waitForTimeout(2000);
      const searchBox = await s.page
        .locator('.settings-editor')
        .first()
        .isVisible()
        .catch(() => false);
      assert(searchBox, 'the Settings editor did not open from the button');
      const query = await s.page
        .locator('.settings-editor .suggest-input-container .monaco-editor')
        .first()
        .innerText()
        .catch(() => '');
      assert(
        /filemaker\.ai/.test(query),
        `Settings opened without the filemaker.ai search: ${query}`
      );
      await s.shot('settings-opened-from-chat');
      await s.closeAllEditors();
      return `answer: ${r.text.slice(0, 120).replace(/\s+/g, ' ')} | buttons: ${r.buttons.join(', ')}`;
    }
  );

  await s.step(
    J,
    'turn AI on and enable the connection (read)',
    'status bar shows AI: read-only',
    async () => {
      await s.setSetting('filemaker.ai.enabled', true);
      await s.cmd('FileMaker: Set AI Access for Connection');
      await answerPickers(s, ['Mock Quality'], { max: 1 });
      await s.pick('Read');
      await s.clickToastButton('Use for AI Tools');
      await s.page.waitForTimeout(1500);
      // The rate limit (30 calls a minute), the record quota and the layout approvals belong to one AI session per
      // window, and the journeys before this one (J10a, J10b) use them up. Start from a fresh session, as a user would
      // between tasks; the product limits stay as they are.
      await s.cmd('FileMaker: Start New AI Session');
      await s.waitModal(10000).catch(() => {});
      if (await s.modalVisible()) await s.modal('Start New Session');
      await s.page.waitForTimeout(800);
      const st = (await s.statusItem(/AI:/)) ?? '';
      assert(/read-only/.test(st), st);
      return st;
    }
  );

  await s.step(
    J,
    '/help works and lists the commands',
    'the five commands and "Nothing is changed by this participant"',
    async () => {
      const r = await ask(s, '@filemaker /help');
      for (const word of [
        '/layouts',
        '/describe',
        '/find',
        '/explain',
        'Nothing is changed by this participant'
      ])
        assert(r.text.includes(word), `missing ${word}`);
    }
  );

  await s.step(
    J,
    '/layouts lists the real layouts as plain text',
    'layout names from the mock appear in a code block; no links or images',
    async () => {
      const r = await ask(s, '@filemaker /layouts');
      assert(/Customers/.test(r.text) && /Orders/.test(r.text), r.text.slice(0, 300));
      const { bad, images } = noActiveContent(r);
      assert(
        bad.length === 0 && images.length === 0,
        `active content: ${JSON.stringify({ bad, images })}`
      );
      assert(r.codeBlocks >= 1, 'names are not in a code block');
      return `${r.text.length} chars; links ${r.links.length}; code blocks ${r.codeBlocks}`;
    }
  );

  await s.step(
    J,
    '/describe asks for layout approval, then lists fields without the hidden ones',
    'a host modal from the tool core; after Allow, fields appear; SSN, Password, Token are absent',
    async () => {
      const r = await ask(s, '@filemaker /describe Customers', {
        answer: 'allow|approve|yes|read|ok'
      });
      assert(
        /Allow an AI tool to read this layout/.test(r.modal) || /read layout/.test(r.modal),
        `modal: ${r.modal}`
      );
      assert(/FirstName|CustomerID/.test(r.text), r.text.slice(0, 300));
      assert(!/\bSSN\b|\bPassword\b|\bToken\b/.test(r.text), 'a hidden field is shown');
      assert(/Value lists are not available/.test(r.text), 'no note on value lists');
      return `modal: ${r.modal.slice(0, 120)}`;
    }
  );

  await s.step(
    J,
    'declining a layout reads nothing',
    'the answer says the user did not allow it; no request for that layout reaches the server',
    async () => {
      const before = (await mock.log()).length;
      const r = await ask(s, '@filemaker /describe Documents', { answer: false });
      assert(/did not allow reading this layout/.test(r.text), r.text.slice(0, 300));
      const reads = (await mock.log())
        .slice(before)
        .filter((l) => l.path.includes('/layouts/Documents'));
      assert(reads.length === 0, `server requests for Documents: ${reads.length}`);
    }
  );

  await s.step(
    J,
    '/find with Field=value is built by the extension, no model call',
    'records are shown, hidden fields absent, the find request is displayed, the model log did not grow',
    async () => {
      const modelsBefore = (await modelLog()).length;
      const r = await ask(s, '@filemaker /find Customers CustomerID=*');
      assert(/Find request \(checked by this extension/.test(r.text), r.text.slice(0, 300));
      assert(/record id:/.test(r.text), `no records: ${r.text.slice(0, 400)}`);
      assert(!/\bSSN\b|\bPassword\b|tok_test_/.test(r.text), 'hidden field content shown');
      assert(
        (await modelLog()).length === modelsBefore,
        'the language model was called for a Field=value request'
      );
      return r.text.slice(0, 200).replace(/\s+/g, ' ');
    }
  );

  await s.step(
    J,
    '/find in plain words uses the model with exactly one required read tool',
    'the fake model got only fm_find_records in required mode, and no server address, user or connection name; records are shown',
    async () => {
      const before = (await modelLog()).length;
      const r = await ask(s, '@filemaker /find Customers show me some customers');
      const log = (await modelLog()).slice(before);
      assert(log.length === 1, `model calls: ${log.length}`);
      assert(
        JSON.stringify(log[0].tools) === JSON.stringify(['fm_find_records']),
        `tools offered: ${JSON.stringify(log[0].tools)}`
      );
      assert(log[0].toolMode === 2, `toolMode ${log[0].toolMode}`);
      for (const secret of [mock.baseUrl, '127.0.0.1', 'tester', 'testpass1', 'Mock Quality'])
        assert(!log[0].body.includes(secret), `the prompt contains ${secret}`);
      assert(/record id:/.test(r.text), `no records: ${r.text.slice(0, 400)}`);
      assert(
        !/Customers[^\n]*\n.*\bSSN\b/.test(log[0].body) &&
          !/"SSN"|"Password"|"Token"/.test(log[0].body),
        'a hidden field name was sent to the model'
      );
      return `prompt ${log[0].body.length} chars`;
    }
  );

  await s.step(
    J,
    'a model that answers with a link and a WRITE tool call runs nothing',
    'the write call is refused unrun, the link is not shown, no write reaches the server, the window is not reloaded',
    async () => {
      await s.setSetting('filemaker.ai.allowWrites', true); // even with writes switched on, the participant offers and runs none
      const before = (await mock.log()).length;
      const r = await ask(s, '@filemaker /find Customers please inject a change');
      const writes = (await mock.log())
        .slice(before)
        .filter(
          (l) =>
            ['PATCH', 'PUT', 'DELETE'].includes(l.method) ||
            (l.method === 'POST' && /\/records$/.test(l.path))
        );
      assert(/does not offer/.test(r.text), r.text.slice(0, 400));
      assert(writes.length === 0, `write requests: ${JSON.stringify(writes)}`);
      assert(!/reloadWindow|click me/.test(r.text), "the model's text was shown");
      const { bad } = noActiveContent(r);
      assert(bad.length === 0, `active links: ${JSON.stringify(bad)}`);
      assert(!(await s.modalVisible()), 'a write dialog opened');
      await s.helper('ping'); // the extension host is still the same one (a reload would have lost the answer)
      await s.setSetting('filemaker.ai.allowWrites', undefined);
    }
  );

  await s.step(J, '/explain explains an error code', 'the meaning of 802 is shown', async () => {
    const r = await ask(s, '@filemaker /explain 802');
    assert(
      /FileMaker error 802/.test(r.text) && /unable to open/i.test(r.text),
      r.text.slice(0, 300)
    );
  });

  await s.step(
    J,
    'Hostile layout: markdown, HTML and command text in data stays inert',
    'record values with markdown breakers, HTML and command text render as text in code blocks: no link, image or command anywhere in the response',
    async () => {
      const r = await ask(s, '@filemaker /find Hostile everything', {
        answer: 'allow|approve|yes|read|ok'
      });
      const { bad, images } = noActiveContent(r);
      await s.shot('hostile-response');
      assert(bad.length === 0, `links with an active scheme: ${JSON.stringify(bad)}`);
      assert(images.length === 0, `images: ${JSON.stringify(images)}`);
      await s.helper('ping');
      return `links in the response: ${JSON.stringify(r.links)} | code blocks ${r.codeBlocks} | text ${r.text.length} chars | head: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`;
    }
  );

  await s.step(
    J,
    'calls are audited as "chat participant"',
    'Show AI Activity lists fm_* calls with client chat participant, and no record values',
    async () => {
      await s.cmd('FileMaker: Show AI Activity');
      await s.page.waitForTimeout(1500);
      // The whole document, not the visible lines: J10a and J10b wrote many entries before this journey.
      const text = (await s.helper('activeDocumentText')).text;
      assert(/chat participant/.test(text) && /fm_find_records/.test(text), text.slice(0, 300));
      assert(!/Ignore previous instructions/.test(text), 'record text in the log');
      await s.closeAllEditors();
    }
  );

  await s.step(
    J,
    'the kill switch turns @filemaker off',
    'after clicking the AI status item, @filemaker says AI is switched off and offers to switch back on',
    async () => {
      await s.clickStatus(/AI:/);
      await s.page.waitForTimeout(800);
      const before = (await mock.log()).length;
      const r = await ask(s, '@filemaker /layouts');
      assert(/switched off for this session/.test(r.text), r.text.slice(0, 300));
      assert(
        r.buttons.some((b) => /Switch AI Tools Back On/.test(b)),
        `buttons ${JSON.stringify(r.buttons)}`
      );
      assert(
        (await mock.log()).slice(before).filter((l) => l.path.includes('/layouts')).length === 0,
        'server read while killed'
      );
      await clickResponseButton(s, 'Switch AI Tools Back On');
      await s.modal('Switch On');
      await s.page.waitForTimeout(500);
      const back = await ask(s, '@filemaker /layouts');
      assert(/Customers/.test(back.text), back.text.slice(0, 200));
    }
  );

  // Leave the window as the next journey expects it: the Chat view is in the secondary side bar and takes width.
  await s.helper('executeCommand', { command: 'workbench.action.closeAuxiliaryBar' }).catch(() => {});

  s.notTestable(
    J,
    'real model behaviour',
    'No Copilot or other real model is available in the harness: tool-call quality, refusals and prompt following of a real model were not tested; a deterministic fake model stood in.'
  );
  s.notTestable(
    J,
    'untrusted workspace',
    'Not run here (the harness window is trusted); covered by the unit policy matrix and by the core trust check.'
  );
}
