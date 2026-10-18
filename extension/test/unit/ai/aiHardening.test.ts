/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { AuditLog, formatAuditLine } from '../../../src/ai/aiAudit';
import { computeAiStatus } from '../../../src/ai/aiRegistration';
import { validateInput } from '../../../src/ai/aiSchema';
import { AI_TOOL_DEFINITIONS } from '../../../src/ai/aiToolDefinitions';
import { SESSION_RECORD_QUOTA } from '../../../src/ai/aiToolService';
import { failure, makeHarness, makeProfile, SECRET_HOST, type Harness } from './harness';

const ready = (): Harness => {
  const h = makeHarness();
  h.settings.readableLayouts = { p1: ['Contacts'] };
  return h;
};
const find = (h: Harness, extra: Record<string, unknown> = {}) =>
  h.service.invoke('fm_find_records', { layout: 'Contacts', requests: [{ fields: { Name: 'a' } }], ...extra }) as Promise<any>;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('record quota under concurrency', () => {
  it('30 parallel finds of 50 can read at most 500 records in total', async () => {
    const h = ready();
    const many = Array.from({ length: 50 }, (_, i) => ({ recordId: String(i), modId: '0', fieldData: { Name: 'n' } }));
    h.client.findRecords.mockImplementation(async (_p: unknown, _l: unknown, body: { limit: number }) => {
      await delay(20);
      return { data: many.slice(0, body.limit), dataInfo: { foundCount: 999 } };
    });
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => find(h, { limit: 50 })));
    const returned = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value.records.length : 0), 0);
    expect(returned).toBeLessThanOrEqual(SESSION_RECORD_QUOTA);
    expect(returned).toBe(SESSION_RECORD_QUOTA);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(20);
    expect(h.service.status().recordsUsed).toBe(SESSION_RECORD_QUOTA);
  });

  it('with 460 records used and a limit of 50, the request asks the server for 40', async () => {
    const h = ready();
    h.client.findRecords.mockImplementation(async (_p: unknown, _l: unknown, body: { limit: number }) => ({
      data: Array.from({ length: body.limit }, (_, i) => ({ recordId: String(i), modId: '0', fieldData: { Name: 'n' } })),
      dataInfo: { foundCount: 999 }
    }));
    for (let i = 0; i < 9; i += 1) await find(h, { limit: 50 });
    await find(h, { limit: 10 });
    expect(h.service.status().recordsUsed).toBe(460);
    await find(h, { limit: 50 });
    expect((h.client.findRecords.mock.calls.at(-1)?.[2] as { limit: number }).limit).toBe(40);
    expect(h.service.status().recordsUsed).toBe(500);
  });

  it('refunds the reservation when the request fails or returns fewer records', async () => {
    const h = ready();
    h.client.findRecords.mockRejectedValueOnce(new Error('boom'));
    await expect(find(h, { limit: 50 })).rejects.toThrow();
    expect(h.service.status().recordsUsed).toBe(0);
    h.client.findRecords.mockResolvedValueOnce({ data: [], dataInfo: { foundCount: 0 } });
    await find(h, { limit: 50 });
    expect(h.service.status().recordsUsed).toBe(0);
  });

  it('passes a response-size limit to the client calls', async () => {
    const h = ready();
    await find(h);
    expect(h.client.findRecords.mock.calls[0]?.[3]).toMatchObject({ maxResponseBytes: 2_000_000 });
    expect(h.client.listLayouts.mock.calls[0]?.[1]).toMatchObject({ maxResponseBytes: 2_000_000 });
  });
});

describe('layout consent under concurrency', () => {
  it('asks once for a layout however many first reads arrive together', async () => {
    const h = makeHarness();
    let release: (value: boolean) => void = () => undefined;
    h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
    const calls = Array.from({ length: 8 }, () => h.service.invoke('fm_describe_layout', { layout: 'Contacts' }));
    await delay(10);
    release(true);
    await Promise.all(calls);
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it('a "no" to the shared prompt refuses every waiting call', async () => {
    const h = makeHarness();
    h.confirm.mockResolvedValue(false);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => h.service.invoke('fm_describe_layout', { layout: 'Contacts' })));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it('stops prompting after 20 layouts in a session', async () => {
    const h = makeHarness();
    const names = Array.from({ length: 22 }, (_, i) => `Layout ${i}`);
    h.client.listLayouts.mockResolvedValue(names);
    const results = await Promise.allSettled(names.map((layout) => h.service.invoke('fm_describe_layout', { layout })));
    expect(h.confirm).toHaveBeenCalledTimes(20);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    h.service.resetSession();
    await expect(h.service.invoke('fm_describe_layout', { layout: 'Layout 21' })).resolves.toBeDefined();
  });

  it('does not keep an approval if policy changed while the prompt was open', async () => {
    const h = makeHarness();
    h.confirm.mockImplementation(async () => {
      h.settings.enabled = false;
      return true;
    });
    expect(await failure(h.service.invoke('fm_describe_layout', { layout: 'Contacts' }))).toMatch(/Policy changed/);
    h.settings.enabled = true;
    h.confirm.mockResolvedValue(true);
    await h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });
});

describe('policy is re-checked after every dialog, before anything is sent', () => {
  const during = (h: Harness, change: () => void) =>
    h.confirm.mockImplementation(async (spec: any) => {
      h.confirms.push(spec);
      if (!spec.title.startsWith('Allow')) change();
      return true;
    });
  const changes: Array<[string, (h: Harness) => void]> = [
    ['the kill switch', (h) => h.service.setKilled(true)],
    ['AI being switched off', (h) => (h.settings.enabled = false)],
    ['writes being switched off', (h) => (h.settings.allowWrites = false)],
    ['the workspace losing trust', (h) => (h.state.trusted = false)],
    ['offline mode', (h) => (h.state.offline = true)],
    ['enterprise policy', (h) => h.state.denyFeatures.add('recordEdit')],
    ['the connection being set to read', (h) => (h.profile.aiAccess = 'read')]
  ];

  it.each(changes)('edit: %s during the dialog sends nothing', async (_label, change) => {
    const h = ready();
    during(h, () => change(h));
    expect(await failure(h.service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1', fields: { Name: 'Z' } }))).toMatch(/Policy changed/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
  });

  it.each(changes)('create: %s during the dialog sends nothing', async (_label, change) => {
    const h = ready();
    during(h, () => change(h));
    await expect(h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'Z' } })).rejects.toThrow(/Policy changed/);
    expect(h.client.createRecord).not.toHaveBeenCalled();
  });

  it('delete: a change during the first dialog or during the typed-id prompt deletes nothing', async () => {
    const first = ready();
    during(first, () => first.service.setKilled(true));
    await expect(first.service.invoke('fm_delete_record', { layout: 'Contacts', recordId: '1' })).rejects.toThrow(/Policy changed/);
    expect(first.input).not.toHaveBeenCalled();

    const second = ready();
    second.input.mockImplementation(async () => {
      second.settings.allowWrites = false;
      return '1';
    });
    await expect(second.service.invoke('fm_delete_record', { layout: 'Contacts', recordId: '1' })).rejects.toThrow(/Policy changed/);
    expect(second.client.deleteRecord).not.toHaveBeenCalled();
  });

  it('script: allowScripts switched off during the dialog runs nothing', async () => {
    const h = ready();
    during(h, () => (h.settings.allowScripts = false));
    await expect(h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Archive Old' })).rejects.toThrow(/Policy changed/);
    expect(h.client.runScript).not.toHaveBeenCalled();
  });
});

describe('repeating fields and hidden fields', () => {
  it('hides Salary(1), Salary(2) and a prefixed repetition in data, portals, criteria, sort and describe', async () => {
    const h = ready();
    h.settings.hiddenFields = ['Salary'];
    h.layoutFields.push({ name: 'Salary(2)', result: 'number' });
    h.records.get('1')!.fieldData['Salary(1)'] = '1';
    h.records.get('1')!.fieldData['Salary(2)'] = '2';
    h.records.get('1')!.portalData = { Orders: [{ 'Orders::Salary(2)': '9', 'Orders::Total': '1' }] };
    const result = await find(h);
    expect(JSON.stringify(result)).not.toMatch(/Salary|90000/);
    expect(JSON.stringify(result)).toContain('Orders::Total');
    expect(await failure(find(h, { requests: [{ fields: { 'Salary(2)': '1' } }] }))).toMatch(/Unknown or unavailable/);
    expect(await failure(find(h, { sort: [{ field: 'Salary(2)' }] }))).toMatch(/Unknown or unavailable/);
    const described = await h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    expect(JSON.stringify(described)).not.toContain('Salary');
  });

  it('an entry with a repetition hides the whole field', async () => {
    const h = ready();
    h.settings.hiddenFields = ['Salary(2)'];
    expect(JSON.stringify(await find(h))).not.toContain('Salary');
  });
});

describe('container URLs and the server address in values', () => {
  const url = `https://${SECRET_HOST}:16000/Streaming_SSL/MainDB/ABC123.jpg?RCType=EmbeddedRCFileProcessor`;

  it('omits container values, repetition keys, portal values and any streaming URL', async () => {
    const h = ready();
    const record = h.records.get('1')!;
    record.fieldData['Photo(2)'] = url;
    record.fieldData.Notes = `see ${url}`;
    record.fieldData.Email = `mail me at ops@${SECRET_HOST}`;
    record.portalData = { Orders: [{ 'Orders::Image': url, 'Orders::Memo': `from ${SECRET_HOST}` }] };
    const text = JSON.stringify(await find(h));
    expect(text).not.toContain(SECRET_HOST);
    expect(text).not.toContain('Streaming');
    expect(text).not.toContain('ABC123');
    expect(text).toContain('[container field omitted]');
    expect(text).toContain('[container or server URL omitted]');
    expect(text).toContain('ops@[server]');
  });

  it('applies to dry-run previews, delete snapshots and script results', async () => {
    const h = ready();
    h.records.get('1')!.fieldData.Notes = url;
    const preview = await h.service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1', fields: { Notes: 'x' }, dryRun: true });
    expect(JSON.stringify(preview)).not.toContain(SECRET_HOST);
    const snap = await h.service.invoke('fm_delete_record', { layout: 'Contacts', recordId: '1', dryRun: true });
    expect(JSON.stringify(snap)).not.toContain(SECRET_HOST);
    h.client.runScript.mockResolvedValue({ messages: [], response: { scriptResult: `at ${SECRET_HOST}`, scriptError: '0' } });
    const ran = (await h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Archive Old' })) as { scriptResult: string };
    expect(ran.scriptResult).toBe('at [server]');
  });
});

describe('error text and audit notes', () => {
  it('removes IP addresses, absolute paths and certificate DNS names from errors', async () => {
    const h = ready();
    h.client.listLayouts.mockRejectedValue(
      new Error(
        "Hostname/IP does not match certificate's altnames: Host: 10.1.2.3. is not in the cert's altnames: DNS:db.corp.example, DNS:*.corp.example; read /Users/me/.certs/ca.pem and C:\\certs\\ca.pem [::1]:443 fe80::1:2"
      )
    );
    const message = await failure(h.service.invoke('fm_list_layouts', {}));
    for (const leak of ['10.1.2.3', 'corp.example', '/Users/me', 'ca.pem', 'C:\\certs', 'fe80::1:2']) {
      expect(message, leak).not.toContain(leak);
    }
  });

  it('runs audit notes through redaction and the same scrub', async () => {
    const h = ready();
    h.client.listLayouts.mockRejectedValue(new Error(`failed for https://${SECRET_HOST}:16000 Bearer abcdef123456 at 10.9.8.7 in /srv/fm/data.fmp12`));
    await failure(h.service.invoke('fm_list_layouts', {}));
    const note = h.audit.at(-1)?.note ?? '';
    expect(note).not.toContain(SECRET_HOST);
    const line = formatAuditLine({ tool: 't', connection: 'c', outcome: 'error', confirmed: null, note: 'Bearer abcdef123456 at 10.9.8.7 in /srv/fm/data.fmp12 on db.corp.example' }, new Date());
    expect(line).not.toMatch(/abcdef123456|10\.9\.8\.7|\/srv|corp\.example/);
  });
});

describe('audit log', () => {
  it('serialises concurrent writes: every line is intact and none is lost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fm-ai-audit-q-'));
    try {
      const log = new AuditLog(join(dir, 'audit.log'));
      await Promise.all(Array.from({ length: 80 }, (_, i) => log.record({ tool: `fm_t${i}`, connection: 'c', outcome: 'ok', confirmed: null })));
      const lines = (await log.read()).trim().split('\n');
      expect(lines).toHaveLength(80);
      expect(lines.every((line) => JSON.parse(line).tool.startsWith('fm_t'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('under concurrent writes and trimming the file stays valid, capped, and leaves no temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fm-ai-audit-t-'));
    try {
      const log = new AuditLog(join(dir, 'audit.log'), () => new Date(), 3000);
      await Promise.all(Array.from({ length: 120 }, (_, i) => log.record({ tool: 'fm_list_layouts', connection: 'c', outcome: 'ok', confirmed: null, note: `n${i}`.padEnd(40, 'x') })));
      const text = await log.read();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3000);
      for (const line of text.trim().split('\n')) JSON.parse(line);
      expect(await readdir(dir)).toEqual(['audit.log']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps write entries when trimming, dropping reads and refusals first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fm-ai-audit-w-'));
    try {
      const log = new AuditLog(join(dir, 'audit.log'), () => new Date(), 4000);
      for (let i = 0; i < 4; i += 1) await log.record({ tool: 'fm_edit_record', connection: 'c', outcome: 'ok', confirmed: true, recordIds: [`${i}`] });
      for (let i = 0; i < 200; i += 1) await log.record({ tool: 'fm_find_records', connection: 'c', outcome: 'refused', confirmed: null, note: 'n'.repeat(40) });
      const text = await log.read();
      expect(text.split('\n').filter((line) => line.includes('fm_edit_record'))).toHaveLength(4);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('logs a flood of gate-refused calls at a limited rate and says how many were not logged', async () => {
    const h = makeHarness();
    await h.service.invoke('fm_list_layouts', {});
    h.settings.enabled = false;
    for (let i = 0; i < 500; i += 1) await failure(h.service.invoke('fm_list_layouts', {}));
    expect(h.audit.length).toBeLessThanOrEqual(11);
    expect(h.audit[0]).toMatchObject({ outcome: 'ok' });
    h.state.now += 61_000;
    await failure(h.service.invoke('fm_list_layouts', {}));
    expect(h.audit.at(-1)?.note).toMatch(/\d+ earlier refusals were not logged/);
  });

  it('refused calls do not use call slots', async () => {
    const h = makeHarness();
    h.settings.enabled = false;
    for (let i = 0; i < 100; i += 1) await failure(h.service.invoke('fm_list_layouts', {}));
    h.settings.enabled = true;
    await expect(h.service.invoke('fm_list_layouts', {})).resolves.toBeDefined();
  });
});

describe('reserved field names and null-prototype objects', () => {
  it('lists "omit" and "__proto__" fields as unusable, and refuses them in criteria, sort and writes', async () => {
    const h = ready();
    h.layoutFields.push({ name: 'omit', result: 'text' }, { name: '__proto__', result: 'text' }, { name: 'Omit(2)', result: 'text' });
    const described = (await h.service.invoke('fm_describe_layout', { layout: 'Contacts' })) as { fields: Array<{ name: string }>; unusableFields: number };
    expect(described.unusableFields).toBe(3);
    expect(described.fields.map((f) => f.name)).not.toContain('omit');
    for (const name of ['omit', '__proto__', 'Omit(2)']) {
      expect(await failure(find(h, { requests: [{ fields: { [name]: 'x' } }] })), name).toMatch(/Unknown or unavailable/);
      expect(await failure(find(h, { sort: [{ field: name }] })), name).toMatch(/Unknown or unavailable/);
      expect(await failure(h.service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1', fields: { [name]: 'x' } })), name).toMatch(/Unknown or unavailable/);
    }
  });

  it('builds criteria without a prototype so a field called "constructor" is only a key', async () => {
    const h = ready();
    h.layoutFields.push({ name: 'constructor', result: 'text' }, { name: 'toString', result: 'text' });
    await find(h, { requests: [{ fields: { constructor: 'a', toString: 'b' } }, { fields: { Name: 'x' }, omit: true }] });
    const query = (h.client.findRecords.mock.calls[0]?.[2] as { query: Array<Record<string, unknown>> }).query;
    expect(Object.getPrototypeOf(query[0])).toBeNull();
    expect(Object.getOwnPropertyNames(query[0]).sort()).toEqual(['constructor', 'toString']);
    expect(query[1]).toMatchObject({ omit: 'true' });
    expect(JSON.parse(JSON.stringify(query[0]))).toEqual({ constructor: 'a', toString: 'b' });
  });

  it('shapes record data without a prototype: a "__proto__" key in data cannot change the output object', async () => {
    const h = ready();
    h.records.set('3', { recordId: '3', modId: '0', fieldData: JSON.parse('{"Name":"p","__proto__":{"polluted":"yes"}}') });
    const result = await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '3' });
    const fields = (result as any).records[0].fields;
    expect(Object.getPrototypeOf(fields)).toBeNull();
    expect(fields.polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe('connection comes only from the user setting', () => {
  it('ignores a project file that names another profile, even one with write access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fm-ai-project-'));
    try {
      const { mkdir, writeFile } = await import('fs/promises');
      await mkdir(join(dir, '.vscode', 'filemaker'), { recursive: true });
      await writeFile(join(dir, '.vscode', 'filemaker', 'project.json'), JSON.stringify({ activeProfileId: 'evil' }));
      const h = makeHarness();
      h.profiles.set('evil', makeProfile({ id: 'evil', name: 'Evil', aiAccess: 'write', serverUrl: 'https://evil.example.com' }));
      await h.service.invoke('fm_list_layouts', {});
      expect(h.getProfile.mock.calls.map((call) => call[0])).toEqual(['p1']);
      expect(h.client.listLayouts).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), expect.anything());
      expect(await readFile(join(dir, '.vscode', 'filemaker', 'project.json'), 'utf8')).toContain('evil');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no AI source file reads a project file or the active profile', async () => {
    const { readdirSync, readFileSync } = await import('fs');
    const folder = join(__dirname, '..', '..', '..', 'src', 'ai');
    for (const file of readdirSync(folder)) {
      const source = readFileSync(join(folder, file), 'utf8');
      expect(source, file).not.toMatch(/project\.json|activeProfileId|getActiveProfileId|FmWebProject/);
    }
  });
});

describe('validator', () => {
  it('treats a schema that omits additionalProperties as closed', () => {
    expect(() => validateInput({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x' })).not.toThrow();
    expect(() => validateInput({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', b: 1 })).toThrow(/unknown property/);
    expect(() => validateInput({ type: 'object' }, { anything: 1 })).toThrow(/unknown property/);
  });
});

describe('status bar shows the effective state', () => {
  const state = { killed: false, recordsUsed: 0, recordQuota: 500, writesUsed: 0, writeCap: 10 };
  it('follows the connection\'s aiAccess, not only the settings', () => {
    expect(computeAiStatus(AI_TOOL_DEFINITIONS, { enabled: true }, state, 'svc', 'read').text).toBe('$(sparkle) AI: read-only');
    expect(computeAiStatus(AI_TOOL_DEFINITIONS, { enabled: true }, state, 'svc', 'write').text).toBe('$(sparkle) AI: scripts on');
    expect(computeAiStatus(AI_TOOL_DEFINITIONS, { enabled: true }, state, 'svc', 'none').text).toContain('connection not enabled');
    expect(computeAiStatus(AI_TOOL_DEFINITIONS, { enabled: true }, state, 'svc', undefined).text).toContain('connection not enabled');
  });
});

describe('quiet vi usage', () => {
  it('keeps vi imported for fake timers if needed', () => {
    expect(vi).toBeDefined();
  });
});
