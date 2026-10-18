// Journey 10a: AI features that need no model: settings, AI access, status bar, Write AI Context, language-model tools
// through the helper extension (vscode.lm.invokeTool), hidden fields, kill switch, Show AI Activity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { answerPickers, connect, createProfile, ensureProfileCommands } from '../lib/flows.mjs';
import { assert } from '../lib/session.mjs';

const J = 'J10a AI tools';
const aiStatus = async (s) => (await s.statusItem(/AI:/)) ?? '(no AI status item)';

/** Invoke a language-model tool through the helper; answer a host-side modal if one appears. */
export async function invoke(s, name, input, { answer, timeout = 40000 } = {}) {
  const p = s.helper('invokeTool', { name, input }, timeout).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.message }));
  let modal;
  if (answer !== undefined) {
    try { modal = await s.waitModal(15000); const buttons = await s.modalButtons(); await s.shot(`modal-${name}`); if (answer) await s.modal(buttons.find((b) => new RegExp(answer, 'i').test(b)) ?? buttons[0]); else await s.modal(buttons.find((b) => /cancel|don'?t|no\b/i.test(b)) ?? 'Cancel'); } catch (e) { modal = `NO MODAL: ${e.message}`; }
  }
  const r = await p;
  return { ...r, modal, text: r.ok ? r.v.parts.map((x) => x.value ?? '').join('\n') : r.e };
}

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) { await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' }); ctx.profileMain = true; }
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? '')) await connect(s, 'Mock Quality');
  const data = mock.data('Quality');
  const man = await mock.manifest();

  await s.step(J, 'AI is off by default', 'status bar says AI: off; the language-model tools are not offered', async () => {
    const st = await aiStatus(s);
    assert(/off/i.test(st), st);
    const tools = await s.helper('listTools');
    const r = await invoke(s, 'fm_list_layouts', {});
    assert(!r.ok || /not available|switched off|turned off|filemaker\.ai/i.test(r.text), `a tool answered while AI is off: ${r.text.slice(0, 160)}`);
    return `${st} | vscode.lm lists ${tools.filter((t) => /^fm_/.test(t.name)).length} fm_ tools (declared with when-clauses; VS Code applies them in chat) | invoking fm_list_layouts while off -> ${r.text.slice(0, 120)}`;
  });
  await s.step(J, 'turn AI on in the Settings UI', 'the filemaker.ai.enabled checkbox in the Settings editor writes the user setting', async () => {
    await s.cmd('Preferences: Open Settings (UI)');
    await s.page.waitForTimeout(1500);
    const search = s.page.locator('.settings-editor .suggest-input-container .monaco-editor, .settings-editor .monaco-editor').first();
    await search.click();
    await s.page.keyboard.type('@id:filemaker.ai.enabled');
    await s.page.waitForTimeout(1500);
    const box = s.page.locator('.settings-editor .setting-item-bool input[type=checkbox], .settings-editor .setting-value-checkbox').first();
    await box.waitFor({ timeout: 10000 });
    await box.click();
    await s.page.waitForTimeout(1500);
    const cur = s.readSettings();
    assert(cur['filemaker.ai.enabled'] === true, `settings.json: ${JSON.stringify(cur['filemaker.ai.enabled'])}`);
    await s.closeAllEditors();
  });
  await s.step(J, 'Set AI Access for Connection: Read, then "Use for AI Tools"', 'access picker with None/Read/Write; an offer to use the connection; status bar shows AI is on for the connection', async () => {
    await s.cmd('FileMaker: Set AI Access for Connection');
    await answerPickers(s, ['Mock Quality'], { max: 1 });
    const items = await s.pickerItems();
    await s.pick('Read');
    await s.clickToastButton('Use for AI Tools');
    await s.page.waitForTimeout(1500);
    const cur = s.readSettings();
    const st = await aiStatus(s);
    assert(cur['filemaker.ai.connection'], `ai.connection not set: ${JSON.stringify(cur['filemaker.ai.connection'])}`);
    return `choices: ${items.join(' / ')} | status: ${st}`;
  });
  await s.step(J, 'read connection: write tools refuse', 'fm_edit_record invoked on a read connection is refused and writes nothing', async () => {
    const pid = man.databases.Quality.tables.Products.conditions.clean[4];
    const before = await data.record('Products', pid);
    const r = await invoke(s, 'fm_edit_record', { layout: 'Products', recordId: pid, fields: { Name: 'read connection write' }, description: 'test' });
    assert((await data.record('Products', pid)).fieldData.Name === before.fieldData.Name, 'record changed');
    assert(!r.ok || /reads only|read.only|not allow|not available/i.test(r.text), `not refused: ${r.text.slice(0, 160)}`);
    return r.text.slice(0, 160);
  });

  // ---- Write AI Context ---------------------------------------------------------------------
  await s.step(J, 'hide fields from AI: filemaker.ai.hiddenFields', 'setting accepted in user settings', async () => {
    await s.setSetting('filemaker.ai.hiddenFields', ['Customers::SSN', 'Customers::Password', 'Customers::Token', 'SSN', 'Password', 'Token']);
  });
  await s.step(J, 'Write AI Context', 'a context file is written with layouts and field names; no secrets, no server address, hidden fields absent', async () => {
    await s.cmd('FileMaker: Write AI Context');
    await answerPickers(s, ['Mock Quality'], { max: 1 });
    await s.pickMany(['Customers', 'Orders', 'Hostile', 'Quote"Layout', 'Back`tick', '../../etc/passwd']);
    const toast = await s.waitToast(/AI context written/i, { timeout: 40000 });
    const m = /: (\/[^ ]+\.md)\s*(Open File|Copy)?/.exec(toast) ?? /(\/[^ ]+ai-context[^ ]*)/.exec(toast);
    assert(m, `no path in: ${toast}`);
    const file = m[1];
    assert(fs.existsSync(file), `file missing: ${file}`);
    const text = fs.readFileSync(file, 'utf8');
    ctx.aiContext = { files: [file], text, toast };
    fs.copyFileSync(file, path.join(ctx.artifacts, 'ai-context.md'));
    const forbidden = ['testpass1', mock.baseUrl, '127.0.0.1', 'SSN', 'Password', 'Token', 'tok_test_', 'Authorization'].filter((x) => text.includes(x));
    assert(/Customers/.test(text) && /FirstName/.test(text), 'no layout/field names in context');
    assert(forbidden.length === 0, `forbidden content present: ${JSON.stringify(forbidden)}`);
    return `${toast.slice(0, 140)} | ${text.length} chars | location ${file.replace(os.tmpdir(), '<tmp>')}`;
  });
  await s.step(J, 'AI context: hostile layout and field names cannot break out of the file structure', 'names with backticks, newlines, markdown or instruction text are neutralised', async () => {
    const text = ctx.aiContext.text;
    const injected = ['Ignore previous instructions', '</script>', '```\nbreak'].filter((x) => text.includes(x));
    const fences = (text.match(/```/g) ?? []).length;
    return `raw injection strings present: ${JSON.stringify(injected)}; code fences in file: ${fences}`;
  });

  // ---- tools through vscode.lm.invokeTool --------------------------------------------------
  await s.step(J, 'fm_list_layouts through vscode.lm.invokeTool', 'returns layout names (data, not instructions); audit entry written', async () => {
    const r = await invoke(s, 'fm_list_layouts', {});
    assert(r.ok && /Customers/.test(r.text), r.text.slice(0, 200));
    return r.text.slice(0, 160);
  });
  await s.step(J, 'fm_describe_layout asks for approval once per session', 'a modal asks to let AI read the layout; accepting returns fields without the hidden ones', async () => {
    const r = await invoke(s, 'fm_describe_layout', { layout: 'Customers' }, { answer: 'allow|approve|yes|read|ok' });
    assert(r.ok, r.text);
    assert(!/"SSN"|"Password"|"Token"/.test(r.text), `hidden fields leaked: ${r.text.slice(0, 300)}`);
    const again = await invoke(s, 'fm_describe_layout', { layout: 'Customers' });
    assert(again.ok && !(await s.modalVisible()), 'asked again for the same layout in the same session');
    return `modal: ${r.modal} | fields shown: ${(r.text.match(/"name"/g) ?? []).length}`;
  });
  await s.step(J, 'decline a layout approval', 'declining returns a refusal and reads nothing from that layout', async () => {
    const logBefore = (await mock.log()).length;
    const r = await invoke(s, 'fm_describe_layout', { layout: 'Documents' }, { answer: false });
    assert(!r.ok || /declin|not approved|refus|cancel/i.test(r.text), r.text.slice(0, 200));
    const reads = (await mock.log()).slice(logBefore).filter((l) => l.path.includes('/layouts/Documents'));
    return `${r.text.slice(0, 120)} | server requests for Documents: ${reads.length}`;
  });
  await s.step(J, 'fm_find_records on the hostile (prompt-injection) records', 'text is returned as data; hidden fields are absent; sizes are capped', async () => {
    const ids = man.databases.Quality.tables.Customers.conditions['prompt-injection'];
    const r = await invoke(s, 'fm_find_records', { layout: 'Customers', requests: [{ fields: { CustomerID: '*' } }], limit: 50 });
    assert(r.ok, r.text);
    assert(!/"SSN"|"Password"|tok_test_/.test(r.text), 'hidden field content present in output');
    const injected = /Ignore previous instructions/.test(r.text);
    return `output ${r.text.length} chars; injection text passed through as data: ${injected}; head: ${r.text.slice(0, 160).replace(/\s+/g, ' ')}`;
  });
  await s.step(J, 'secret-like and host-like values in records are scrubbed', 'the mock host, the session token and token-shaped strings do not reach the model', async () => {
    const ids = man.databases.Quality.tables.Customers.conditions['host-like'];
    const out = [];
    for (const id of ids) { const r = await invoke(s, 'fm_get_record', { layout: 'Customers', recordId: id }); out.push(r.text); }
    const text = out.join('\n');
    const leaks = [mock.baseUrl, '127.0.0.1:', new URL(mock.baseUrl).host].filter((x) => text.includes(x));
    return `leaks of the server address: ${JSON.stringify(leaks)}; AKIA key present: ${/AKIAIOSFODNN7EXAMPLE/.test(text)}`;
  });
  await s.step(J, 'record quota per session', 'after the per-session record budget the tool refuses with a clear message', async () => {
    let last; let calls = 0;
    for (let i = 0; i < 12; i += 1) { last = await invoke(s, 'fm_find_records', { layout: 'Customers', requests: [{ fields: { CustomerID: '*' } }], limit: 50 }); calls += 1; if (!last.ok || /quota|limit|budget/i.test(last.text.slice(0, 300))) break; }
    return `${calls} calls of 50 records; last: ${last.text.slice(0, 200).replace(/\s+/g, ' ')}`;
  });
  await s.step(J, 'Show AI Activity', 'a document lists the tool calls with outcome, no record contents or secrets', async () => {
    await s.cmd('FileMaker: Show AI Activity');
    await s.page.waitForTimeout(1500);
    const text = await s.activeEditorText();
    assert(/fm_list_layouts/.test(text), text.slice(0, 200));
    assert(!/tok_test_|testpass1|Ignore previous instructions/.test(text), 'record contents in the audit view');
    await s.closeAllEditors();
    return text.replace(/\s+/g, ' ').slice(0, 200);
  });
  await s.step(J, 'status bar item is the kill switch', 'clicking it switches AI tools off: tools vanish and calls are refused; switching on asks in a modal', async () => {
    await s.clickStatus(/AI:/);
    await s.page.waitForTimeout(1500);
    const st = await aiStatus(s);
    const tools = (await s.helper('listTools')).filter((t) => /^fm_/.test(t.name));
    const r = await invoke(s, 'fm_list_layouts', {});
    await s.clickStatus(/AI:/);
    const text = await s.waitModal(10000);
    await s.modal('Switch On');
    await s.page.waitForTimeout(1000);
    return `off: status "${st}", tools listed ${tools.length}, call -> ${r.ok ? 'OK (not refused!)' : r.text.slice(0, 100)} | switch-on modal: ${text.slice(0, 100)} | after: ${await aiStatus(s)}`;
  });
  await s.step(J, 'Start New AI Session resets approvals', 'modal; afterwards the layout approval is asked again', async () => {
    await s.cmd('FileMaker: Start New AI Session');
    await s.waitModal(10000);
    await s.modal('Start New Session');
    await s.page.waitForTimeout(800);
    const r = await invoke(s, 'fm_describe_layout', { layout: 'Customers' }, { answer: 'allow|approve|yes|read|ok' });
    assert(!String(r.modal).startsWith('NO MODAL'), `no approval modal after a new session: ${r.modal}`);
    return String(r.modal).slice(0, 140);
  });
  await s.step(J, 'write access: connection write + allowWrites', 'write tools appear; edit asks in a modal that names the record and field changes; decline writes nothing; accept writes', async () => {
    await s.cmd('FileMaker: Set AI Access for Connection');
    await answerPickers(s, ['Mock Quality'], { max: 1 });
    await s.pick('Write');
    await s.page.waitForTimeout(800);
    await s.dismissToasts();
    await s.setSetting('filemaker.ai.allowWrites', true);
    await s.page.waitForTimeout(1000);
    const tools = (await s.helper('listTools')).filter((t) => /^fm_/.test(t.name)).map((t) => t.name);
    assert(tools.includes('fm_edit_record'), `tools: ${tools.join(', ')}`);
    const pid = man.databases.Quality.tables.Products.conditions.clean[5];
    const before = await data.record('Products', pid);
    await invoke(s, 'fm_describe_layout', { layout: 'Products' }, { answer: 'allow|approve|yes|read|ok' });
    const declined = await invoke(s, 'fm_edit_record', { layout: 'Products', recordId: pid, fields: { Name: 'AI edit declined' }, description: 'test' }, { answer: false });
    assert((await data.record('Products', pid)).fieldData.Name === before.fieldData.Name, 'declined edit was written');
    const accepted = await invoke(s, 'fm_edit_record', { layout: 'Products', recordId: pid, fields: { Name: 'AI edit accepted' }, description: 'test' }, { answer: 'save|apply|allow|yes|ok|change' });
    assert((await data.record('Products', pid)).fieldData.Name === 'AI edit accepted', `edit not applied: ${accepted.text.slice(0, 200)}`);
    return `modal: ${String(accepted.modal).replace(/\s+/g, ' ').slice(0, 260)}`;
  });
  await s.step(J, 'AI write refused by the FileMaker account (read-only account) is reported truthfully', 'the tool reports the failure; never success', async () => {
    // Re-point the connection at the read-only mock account.
    await s.closeAllEditors();
    await createProfile(s, { name: 'Mock Reader', url: mock.baseUrl, database: 'Quality', username: 'reader', password: 'readpass1' });
    await s.cmd('FileMaker: Set AI Access for Connection');
    await answerPickers(s, ['Mock Reader'], { max: 1 });
    await s.pick('Write');
    await s.clickToastButton('Use for AI Tools').catch(() => {});
    await s.page.waitForTimeout(1500);
    const pid = man.databases.Quality.tables.Products.conditions.clean[6];
    await invoke(s, 'fm_describe_layout', { layout: 'Products' }, { answer: 'allow|approve|yes|read|ok' }).catch(() => {});
    const r = await invoke(s, 'fm_edit_record', { layout: 'Products', recordId: pid, fields: { Name: 'reader tries' }, description: 'test' }, { answer: 'save|apply|allow|yes|ok|change' });
    const rec = await data.record('Products', pid);
    assert(rec.fieldData.Name !== 'reader tries', 'the write reached the server');
    assert(!/written\W+true|"written":\s*true|success/i.test(r.text) || /not|fail|denied|privilege|\b9\b/i.test(r.text), `output claims success: ${r.text.slice(0, 300)}`);
    return r.text.slice(0, 260).replace(/\s+/g, ' ');
  });
}
