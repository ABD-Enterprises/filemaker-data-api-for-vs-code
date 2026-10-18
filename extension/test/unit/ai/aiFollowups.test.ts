/* eslint-disable @typescript-eslint/no-explicit-any */
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { AuditLog, type AuditIo } from '../../../src/ai/aiAudit';
import { PLACEHOLDER_MARKERS } from '../../../src/ai/aiText';
import { buildCreateConfirmation, buildDeleteConfirmation, buildEditConfirmation, scrub } from '../../../src/ai/aiToolService';
import { failure, makeHarness, makeProfile, SECRET_HOST, type Harness } from './harness';

const ready = (): Harness => {
  const h = makeHarness();
  h.settings.readableLayouts = { p1: ['Contacts'] };
  return h;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const edit = (h: Harness, fields: Record<string, string>) =>
  h.service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1', fields });

describe('dialog size budget', () => {
  const heavy = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ name: `${'N'.repeat(100)}${i}`, oldValue: 'o'.repeat(100), newValue: '*'.repeat(200) }));

  it('refuses an edit or create whose escaped dialog would pass 4,000 characters, and builds anything under it', () => {
    expect(() => buildEditConfirmation({ profile: makeProfile(), layout: 'L', recordId: '1', changes: heavy(4) })).toThrow(/longer than 4000/);
    expect(() =>
      buildCreateConfirmation({ profile: makeProfile(), layout: 'L', values: heavy(4).map((c) => [c.name, c.newValue] as [string, string]) })
    ).toThrow(/longer than 4000/);
    const small = buildEditConfirmation({
      profile: makeProfile(),
      layout: 'L',
      recordId: '1',
      changes: Array.from({ length: 10 }, (_, i) => ({ name: `Field ${i}`, oldValue: 'a', newValue: 'b'.repeat(200) }))
    });
    expect(small.detail.length).toBeLessThanOrEqual(4000);
    expect(small.detail.split('b'.repeat(200))).toHaveLength(11);
  });

  it('keeps the model\'s description visible: the whole detail is checked, not only the diff', () => {
    expect(() =>
      buildEditConfirmation({
        profile: makeProfile(),
        layout: 'L',
        recordId: '1',
        changes: Array.from({ length: 10 }, (_, i) => ({ name: `F${i}`, oldValue: 'a', newValue: '*'.repeat(90) })),
        description: '*'.repeat(200)
      })
    ).toThrow(/longer than 4000/);
  });

  it('refuses such a write in the service before any dialog or write attempt', async () => {
    const h = ready();
    for (let i = 0; i < 10; i += 1) h.layoutFields.push({ name: `Wide${'W'.repeat(120)}${i}`, result: 'text' });
    const fields = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Wide${'W'.repeat(120)}${i}`, '<'.repeat(200)]));
    expect(await failure(edit(h, fields))).toMatch(/longer than 4000/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.confirms.filter((spec) => spec.title.includes('change'))).toHaveLength(0);
    expect(h.service.status().writesUsed).toBe(0);
  });

  it('shrinks a delete snapshot to fit instead of blocking the delete, and keeps the description', () => {
    const snapshot = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${'F'.repeat(120)}${i}`, '*'.repeat(60)]));
    const spec = buildDeleteConfirmation({ profile: makeProfile(), layout: 'L', recordId: '1', snapshot, description: 'because' });
    expect(spec.detail.length).toBeLessThanOrEqual(4000);
    expect(spec.detail).toMatch(/first \d+ of 10 fields/);
    expect(spec.detail.split('\n').at(-1)).toContain('because');
  });
});

describe('placeholder markers in written values', () => {
  it.each([...PLACEHOLDER_MARKERS])('refuses a value containing %s', async (marker) => {
    const h = ready();
    expect(await failure(edit(h, { Name: `a ${marker} b` }))).toMatch(/may not contain/);
    await expect(h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: marker } })).rejects.toThrow(/may not contain/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.client.createRecord).not.toHaveBeenCalled();
  });

  it('knows all five markers', () => {
    expect([...PLACEHOLDER_MARKERS].sort()).toEqual(['***', '[container field omitted]', '[container or server URL omitted]', '[hidden]', '[server]'].sort());
  });
});

describe('server-address scrub', () => {
  const profile = makeProfile({ serverUrl: 'https://fm.corp.example:16000', username: 'admin', proxyEndpoint: undefined });

  it('removes URLs, host:port and @host, and leaves the user name as an ordinary word', () => {
    expect(scrub('Contact the admin about https://fm.corp.example:16000/fmi/data failing', profile)).toBe('Contact the admin about [server]/fmi/data failing');
    expect(scrub('connect fm.corp.example:16000 refused; mail admin@fm.corp.example', profile)).toBe('connect [server] refused; mail admin@[server]');
    expect(scrub('The admin must reset the admin account', profile)).toBe('The admin must reset the admin account');
  });

  it('matches the host as a whole token, not inside other words', () => {
    const short = makeProfile({ serverUrl: 'https://fm:16000', username: 'u' });
    expect(scrub('please confirm the fm server', short)).toBe('please confirm the [server] server');
    expect(scrub('Fmi and information', short)).toBe('Fmi and information');
  });

  it('through the service: "Contact the admin" survives, the host does not', async () => {
    const h = ready();
    h.profile.username = 'admin';
    h.client.listLayouts.mockRejectedValue(new Error(`Contact the admin: ${SECRET_HOST}:16000 is down`));
    const message = await failure(h.service.invoke('fm_list_layouts', {}));
    expect(message).toContain('Contact the admin');
    expect(message).not.toContain(SECRET_HOST);
  });
});

describe('session reset with calls in flight', () => {
  it('a late refund from before the reset cannot make the quota negative', async () => {
    const h = ready();
    h.client.findRecords.mockImplementation(async () => {
      await delay(30);
      return { data: [{ recordId: '1', modId: '0', fieldData: { Name: 'a' } }], dataInfo: { foundCount: 1 } };
    });
    const pending = h.service.invoke('fm_find_records', { layout: 'Contacts', requests: [{ fields: { Name: 'a' } }], limit: 50 });
    await delay(5);
    h.service.resetSession();
    await pending;
    expect(h.service.status().recordsUsed).toBe(0);
    await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' });
    expect(h.service.status().recordsUsed).toBe(1);
  });

  it('a failed request from before the reset does not refund into the new session either', async () => {
    const h = ready();
    h.client.findRecords.mockImplementation(async () => {
      await delay(20);
      throw new Error('boom');
    });
    const pending = h.service.invoke('fm_find_records', { layout: 'Contacts', requests: [{ fields: { Name: 'a' } }], limit: 50 });
    await delay(5);
    h.service.resetSession();
    await failure(pending);
    expect(h.service.status().recordsUsed).toBe(0);
  });

  it('an approval given in a dialog opened before the reset is not kept', async () => {
    const h = makeHarness();
    let release: (value: boolean) => void = () => undefined;
    h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
    const pending = h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    await delay(5);
    h.service.resetSession();
    release(true);
    expect(await failure(pending)).toMatch(/session was reset/);
    h.confirm.mockResolvedValue(true);
    await h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });
});

describe('policy re-check covers the allowlist, approved layouts and the profile', () => {
  const during = (h: Harness, change: () => void) =>
    h.confirm.mockImplementation(async (spec: any) => {
      h.confirms.push(spec);
      if (!spec.title.startsWith('Allow')) change();
      return true;
    });

  it('a script removed from the allowlist during the dialog is not run', async () => {
    const h = ready();
    during(h, () => (h.settings.scriptAllowlist = { p1: [] }));
    expect(await failure(h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Archive Old' }))).toMatch(/no longer on the allowlist/);
    expect(h.client.runScript).not.toHaveBeenCalled();
  });

  it('a layout removed from readableLayouts during the dialog is not written to (when it was not approved by prompt)', async () => {
    const h = ready();
    during(h, () => (h.settings.readableLayouts = {}));
    expect(await failure(edit(h, { Name: 'Z' }))).toMatch(/no longer approved/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
  });

  it('a layout approved by prompt stays approved', async () => {
    const h = makeHarness();
    await expect(edit(h, { Name: 'Z' })).resolves.toMatchObject({ written: true });
  });

  it('switching the AI connection to another profile during the dialog sends nothing', async () => {
    const h = ready();
    h.profiles.set('other', makeProfile({ id: 'other', name: 'Other', aiAccess: 'write' }));
    during(h, () => (h.settings.connection = 'other'));
    expect(await failure(edit(h, { Name: 'Z' }))).toMatch(/connection for AI use changed/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
  });

  it('editing the same profile to point at another server during the dialog sends nothing', async () => {
    const h = ready();
    during(h, () => h.profiles.set('p1', { ...h.profile, serverUrl: 'https://elsewhere.example.com' }));
    expect(await failure(edit(h, { Name: 'Z' }))).toMatch(/connection for AI use changed/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
  });

  it('replacing the profile object under the same id with another database is caught', async () => {
    const h = ready();
    during(h, () => h.profiles.set('p1', { ...h.profile, database: 'Other' }));
    expect(await failure(edit(h, { Name: 'Z' }))).toMatch(/connection for AI use changed/);
  });
});

describe('container fields keyed by repetition', () => {
  it('omits a container value stored under Photo(2) even when it is not a URL', async () => {
    const h = ready();
    h.records.get('1')!.fieldData['Photo(2)'] = 'plain-binary-token';
    const result = (await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' })) as any;
    expect(result.records[0].fields['Photo(2)']).toBe('[container field omitted]');
    expect(JSON.stringify(result)).not.toContain('plain-binary-token');
  });
});

describe('audit queue (injected delays)', () => {
  it('never runs two file operations at once, so an append cannot overlap a trim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fm-ai-audit-io-'));
    try {
      let running = 0;
      let peak = 0;
      const slow =
        <T extends (...args: any[]) => Promise<any>>(fn: T): T =>
          (async (...args: any[]) => {
            running += 1;
            peak = Math.max(peak, running);
            await delay(2);
            try {
              return await fn(...args);
            } finally {
              running -= 1;
            }
          }) as T;
      const io: AuditIo = {
        mkdir: slow(mkdir) as never,
        appendFile: slow(appendFile) as never,
        stat: slow(stat) as never,
        readFile: slow(readFile) as never,
        writeFile: slow(writeFile) as never,
        rename: slow(rename) as never
      };
      const log = new AuditLog(join(dir, 'audit.log'), () => new Date(), 1500, io);
      await Promise.all(Array.from({ length: 40 }, (_, i) => log.record({ tool: 'fm_find_records', connection: 'c', outcome: 'ok', confirmed: null, note: `n${i}`.padEnd(40, 'x') })));
      expect(peak).toBe(1);
      const text = await readFile(join(dir, 'audit.log'), 'utf8');
      for (const line of text.trim().split('\n')) JSON.parse(line);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
