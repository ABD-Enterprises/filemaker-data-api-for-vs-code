import { describe, expect, it } from 'vitest';

import { CALLS_PER_MINUTE } from '../../../src/ai/aiToolService';
import { failure, makeHarness, SECRET_HOST } from './harness';

const readNames = ['fm_describe_layout', 'fm_explain_error', 'fm_find_records', 'fm_get_record', 'fm_list_layouts', 'fm_list_scripts'];
const writeNames = ['fm_create_record', 'fm_delete_record', 'fm_edit_record'];

describe('which tools are offered', () => {
  it('offers read tools only by default, writes with allowWrites, the script tool with allowScripts', () => {
    const h = makeHarness({ settings: { allowWrites: false, allowScripts: false } });
    expect(h.service.listTools().map((tool) => tool.name).sort()).toEqual(readNames);

    h.settings.allowWrites = true;
    expect(h.service.listTools().map((tool) => tool.name).sort()).toEqual([...readNames, ...writeNames].sort());

    h.settings.allowScripts = true;
    expect(h.service.listTools().map((tool) => tool.name)).toContain('fm_run_script');
  });

  it.each([
    ['AI is not enabled', (h: ReturnType<typeof makeHarness>) => (h.settings.enabled = false)],
    ['the workspace is untrusted', (h: ReturnType<typeof makeHarness>) => (h.state.trusted = false)],
    ['offline mode is on', (h: ReturnType<typeof makeHarness>) => (h.state.offline = true)],
    ['the feature switch is off', (h: ReturnType<typeof makeHarness>) => (h.state.featureSwitch = false)],
    ['enterprise policy disables ai', (h: ReturnType<typeof makeHarness>) => h.state.denyFeatures.add('ai')],
    ['the kill switch is on', (h: ReturnType<typeof makeHarness>) => h.service.setKilled(true)]
  ])('offers nothing and refuses every tool when %s', async (_label, apply) => {
    const h = makeHarness();
    apply(h);
    expect(h.service.listTools()).toEqual([]);
    for (const name of [...readNames, ...writeNames, 'fm_run_script']) {
      await expect(h.service.invoke(name, validInput(name))).rejects.toThrow();
    }
    expect(h.client.listLayouts).not.toHaveBeenCalled();
  });

  it('withholds write tools when enterprise policy disables record editing, and the script tool when it disables scripts', () => {
    const h = makeHarness();
    h.state.denyFeatures.add('recordEdit');
    expect(h.service.listTools().map((tool) => tool.name)).not.toContain('fm_edit_record');
    h.state.denyFeatures.clear();
    h.state.denyFeatures.add('scriptRunner');
    expect(h.service.listTools().map((tool) => tool.name)).not.toContain('fm_run_script');
    expect(h.service.listTools().map((tool) => tool.name)).toContain('fm_edit_record');
  });
});

function validInput(name: string): unknown {
  const base = { layout: 'Contacts' };
  switch (name) {
    case 'fm_describe_layout':
      return base;
    case 'fm_find_records':
      return { ...base, requests: [{ fields: { Name: 'Ada' } }] };
    case 'fm_get_record':
      return { ...base, recordId: '1' };
    case 'fm_explain_error':
      return { code: 401 };
    case 'fm_edit_record':
      return { ...base, recordId: '1', fields: { Name: 'X' } };
    case 'fm_create_record':
      return { ...base, fields: { Name: 'X' } };
    case 'fm_delete_record':
      return { ...base, recordId: '1' };
    case 'fm_run_script':
      return { ...base, script: 'Archive Old' };
    default:
      return {};
  }
}

describe('per-call policy', () => {
  it('refuses an unknown tool', async () => {
    await expect(makeHarness().service.invoke('fm_drop_database', {})).rejects.toThrow(/Unknown tool/);
  });

  it('refuses write and script tools that are switched off even if a caller names them', async () => {
    const h = makeHarness({ settings: { allowWrites: false, allowScripts: false } });
    expect(await failure(h.service.invoke('fm_edit_record', validInput('fm_edit_record')))).toMatch(/allowWrites/);
    expect(await failure(h.service.invoke('fm_run_script', validInput('fm_run_script')))).toMatch(/allowScripts/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('refuses a write tool when enterprise policy blocks it, and still allows reads', async () => {
    const h = makeHarness();
    h.state.denyFeatures.add('writeOperations');
    expect(await failure(h.service.invoke('fm_create_record', validInput('fm_create_record')))).toMatch(/disabled by policy/);
    await expect(h.service.invoke('fm_list_layouts', {})).resolves.toBeDefined();
  });

  it('needs a connection chosen by the user setting', async () => {
    const none = makeHarness({ settings: { connection: undefined } });
    expect(await failure(none.service.invoke('fm_list_layouts', {}))).toMatch(/filemaker\.ai\.connection/);

    const missing = makeHarness({ settings: { connection: 'does-not-exist' } });
    expect(await failure(missing.service.invoke('fm_list_layouts', {}))).toMatch(/does not exist/);
  });

  it('needs the profile to allow AI: none refuses, read allows reads only, write allows writes', async () => {
    const off = makeHarness({ profile: { aiAccess: undefined } });
    expect(await failure(off.service.invoke('fm_list_layouts', {}))).toMatch(/not enabled for AI/);
    const none = makeHarness({ profile: { aiAccess: 'none' } });
    expect(await failure(none.service.invoke('fm_list_layouts', {}))).toMatch(/not enabled for AI/);

    const read = makeHarness({ profile: { aiAccess: 'read' } });
    await expect(read.service.invoke('fm_list_layouts', {})).resolves.toBeDefined();
    expect(await failure(read.service.invoke('fm_edit_record', validInput('fm_edit_record')))).toMatch(/reads only/);
    expect(await failure(read.service.invoke('fm_run_script', validInput('fm_run_script')))).toMatch(/reads only/);
    expect(read.client.editRecord).not.toHaveBeenCalled();
  });

  it('never uses a project-file connection: the only input is the user setting', async () => {
    const h = makeHarness({ settings: { connection: 'p1' } });
    // A different "active profile" has no effect: getProfile is only ever asked for settings.connection.
    await h.service.invoke('fm_list_layouts', {});
    expect(h.client.listLayouts).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), expect.anything());
  });

  it('rejects input that does not match the closed schema', async () => {
    const h = makeHarness();
    expect(await failure(h.service.invoke('fm_list_layouts', { extra: 1 }))).toMatch(/unknown property/);
    expect(await failure(h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1; DROP' }))).toMatch(/invalid format/);
    expect(await failure(h.service.invoke('fm_get_record', 'text'))).toMatch(/must be an object/);
  });

  it('limits calls to 30 per minute and recovers after a minute', async () => {
    const h = makeHarness();
    for (let index = 0; index < CALLS_PER_MINUTE; index += 1) {
      await h.service.invoke('fm_explain_error', { code: 0 });
    }
    expect(await failure(h.service.invoke('fm_explain_error', { code: 0 }))).toMatch(/Rate limit/);
    h.state.now += 61_000;
    await expect(h.service.invoke('fm_explain_error', { code: 0 })).resolves.toBeDefined();
  });

  it('explains errors from a built-in table without touching the server', async () => {
    const h = makeHarness();
    expect(await h.service.invoke('fm_explain_error', { code: 306 })).toMatchObject({ known: true });
    expect(await h.service.invoke('fm_explain_error', { code: 77777 })).toMatchObject({ known: false });
    expect(h.client.listLayouts).not.toHaveBeenCalled();
  });

  it('never puts the server address or user name in an error from the client', async () => {
    const h = makeHarness();
    h.client.listLayouts.mockRejectedValue(
      new Error(`connect ECONNREFUSED https://${SECRET_HOST}:16000/fmi/data as ai_reader with Bearer abcdef123456`)
    );
    const message = await failure(h.service.invoke('fm_list_layouts', {}));
    for (const secret of [SECRET_HOST, '16000', 'ai_reader', 'abcdef123456']) {
      expect(message, secret).not.toContain(secret);
    }
    expect(message).toMatch(/request failed/);
  });

  it('turning the kill switch back on starts a new session: counters and approvals are reset', async () => {
    const h = makeHarness();
    await h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    expect(h.confirm).toHaveBeenCalledTimes(1);
    await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' });
    expect(h.service.status().recordsUsed).toBe(1);

    h.service.setKilled(true);
    h.service.setKilled(false);
    expect(h.service.status().recordsUsed).toBe(0);
    await h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it('records every call in the audit log with the outcome, including refusals', async () => {
    const h = makeHarness();
    await h.service.invoke('fm_list_layouts', {});
    h.state.offline = true;
    await failure(h.service.invoke('fm_list_layouts', {}));
    expect(h.audit.map((entry) => [entry.tool, entry.outcome])).toEqual([
      ['fm_list_layouts', 'ok'],
      ['fm_list_layouts', 'refused']
    ]);
  });
});
