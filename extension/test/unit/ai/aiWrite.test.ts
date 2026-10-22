/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';

import {
  buildCreateConfirmation,
  buildEditConfirmation,
  buildScriptConfirmation,
  WRITES_PER_MINUTE,
  WRITES_PER_SESSION
} from '../../../src/ai/aiToolService';
import { failure, makeHarness, makeProfile, type Harness } from './harness';

const ready = (): Harness => {
  const h = makeHarness();
  h.settings.readableLayouts = { p1: ['Contacts'] };
  return h;
};
const edit = (h: Harness, fields: Record<string, string>, extra: Record<string, unknown> = {}) =>
  h.service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1', fields, ...extra }) as Promise<Record<string, any>>;

it.each(['fm_edit_record', 'fm_create_record'].flatMap((tool) => ['A\0B', 'A\0B\0C'].map((value) => ({ tool, value }))))('$tool refuses NUL with a data loss explanation before approval: $value', async ({ tool, value }) => {
  const h = ready();
  const error = await failure(h.service.invoke(tool, { layout: 'Contacts', ...(tool === 'fm_edit_record' ? { recordId: '1' } : {}), fields: { Name: value } }));
  expect(error).toContain('Name');
  expect(error).toContain('On the FileMaker server we tested, FileMaker kept only the text before this character and dropped the rest.');
  expect(h.confirms).toHaveLength(0);
  expect(h.client.editRecord).not.toHaveBeenCalled();
  expect(h.client.createRecord).not.toHaveBeenCalled();
});

it.each(['fm_edit_record', 'fm_create_record'].flatMap((tool) => [' Calculation ', ' SUMMARY ', 'container'].map((type) => ({ tool, type }))))('$tool refuses read-only metadata $type before approval', async ({ tool, type }) => {
  const h = ready();
  h.layoutFields.push({ name: ' Calc ', type, result: type === 'container' ? ' Container ' : 'number' } as { name: string; result: string });
  const message = await failure(h.service.invoke(tool, { layout: 'Contacts', ...(tool === 'fm_edit_record' ? { recordId: '1' } : {}), fields: { ' Calc ': '5' } }));
  expect(message).toMatch(/(calculation|summary|container) fields cannot be written/i);
  expect(h.confirms).toHaveLength(0);
  expect(h.client.editRecord).not.toHaveBeenCalled();
  expect(h.client.createRecord).not.toHaveBeenCalled();
});

describe('fm_edit_record', () => {
  it('shows a host-built diff first, labels the model\'s own words last, then sends only changed fields with the confirm-time modId', async () => {
    const h = ready();
    const result = await edit(h, { Name: 'Grace', Email: 'ada@example.com' }, { description: 'Fix the name' });

    expect(result).toMatchObject({ written: true, fieldsChanged: ['Name'] });
    expect(h.client.editRecord).toHaveBeenCalledWith(
      expect.anything(), 'Contacts', '1', { Name: 'Grace' }, expect.anything(), { modId: '3' }
    );

    const spec = h.confirms[0]!;
    const lines = spec.detail.split('\n');
    expect(lines.slice(0, 3)).toEqual(['Connection: "Dev Server"', 'Account: "ai_reader"', 'Layout: "Contacts"']);
    expect(lines[3]).toBe('Record id: "1"');
    expect(lines[4]).toBe('Fields changed: 1');
    expect(lines[6]).toBe('"Name": "Ada" -> "Grace"');
    expect(lines.at(-1)).toBe('The AI tool\'s own description (not verified): "Fix the name"');
    expect(spec.message).toMatch(/AI tool/);
  });

  it('escapes hostile names, values and descriptions so they cannot fake lines or hide text', () => {
    const profile = makeProfile({ name: 'Dev\nAccount: "root"', username: 'u\u202Eser' });
    const spec = buildEditConfirmation({
      profile,
      layout: 'Contacts\nLayout: "Other"',
      recordId: '1',
      changes: [
        { name: 'Notes', oldValue: 'old\nFields changed: 0', newValue: 'new\u2028Connection: "Evil"' },
        { name: 'x'.repeat(200), oldValue: 'o'.repeat(500), newValue: 'y'.repeat(200) }
      ],
      description: 'ok\nConnection: "Trusted"\u202E [click](https://evil.example) <b>x</b> `c`'
    });
    const lines = spec.detail.split('\n');
    // Exactly: 3 host facts, record id, count, blank, 2 diff lines, blank, 1 description.
    expect(lines).toHaveLength(10);
    expect(lines.filter((line) => line.startsWith('Connection:'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('Account:'))).toHaveLength(1);
    expect(spec.detail).not.toMatch(/[\u2028\u202E]/);
    // Markdown control characters never reach the dialog as themselves.
    expect(spec.detail.replaceAll(' -> ', ' ')).not.toMatch(/[[\]<>`*~|]/);
    expect(lines[5]).toBe('');
    // A long field name and old value are cut with a visible count; the new value is whole.
    expect(lines[7]).toContain('(+72 more characters)');
    expect(lines[7]).toContain('(+400 more characters)');
    expect(lines[7]).toContain('y'.repeat(200));
    expect(lines.at(-1)!.startsWith('The AI tool\'s own description (not verified): ')).toBe(true);
    expect(lines.at(-1)).toContain('\\u202e');
  });

  it('shows every changed field and every new value in full, and refuses a write it could not show in full', () => {
    const change = (index: number, value = 'v'.repeat(200)) => ({ name: `Field ${index}`, oldValue: 'a', newValue: value });
    const ten = Array.from({ length: 10 }, (_, index) => change(index));
    const spec = buildEditConfirmation({ profile: makeProfile(), layout: 'L', recordId: '1', changes: ten });
    expect(spec.detail.split('\n').filter((line) => line.includes('->'))).toHaveLength(10);
    expect(spec.detail.split('v'.repeat(200)).length - 1).toBe(10);
    expect(spec.detail).not.toContain('more fields');
    expect(spec.detail).not.toContain('(+');

    expect(() => buildEditConfirmation({ profile: makeProfile(), layout: 'L', recordId: '1', changes: [...ten, change(10)] })).toThrow(/too large/);
    expect(() => buildEditConfirmation({ profile: makeProfile(), layout: 'L', recordId: '1', changes: [change(0, 'v'.repeat(201))] })).toThrow(/too large/);
    expect(() => buildCreateConfirmation({ profile: makeProfile(), layout: 'L', values: Array.from({ length: 11 }, (_, i) => [`F${i}`, 'x'] as [string, string]) })).toThrow(/too large/);
    expect(() => buildScriptConfirmation({ profile: makeProfile(), layout: 'L', script: 'S', parameter: 'p'.repeat(201) })).toThrow(/too (large|long)/);
  });

  it('refuses, before any dialog or request, a write with more than 10 fields or a value over 200 characters', async () => {
    const h = ready();
    for (let i = 0; i < 11; i += 1) h.layoutFields.push({ name: `Extra${i}`, result: 'text' });
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Extra${i}`, 'x']));
    await expect(edit(h, eleven)).rejects.toThrow();
    expect(await failure(edit(h, { Name: 'y'.repeat(201) }))).toMatch(/at most 200/);
    await expect(h.service.invoke('fm_create_record', { layout: 'Contacts', fields: eleven })).rejects.toThrow();
    await expect(h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Archive Old', parameter: 'p'.repeat(201) })).rejects.toThrow();
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.client.createRecord).not.toHaveBeenCalled();
    expect(h.confirms.filter((spec) => /change|create|run/.test(spec.title))).toHaveLength(0);
    expect(h.service.status().writesUsed).toBe(0);
  });

  it('sends exactly the fields the dialog listed, with exactly the values it showed', async () => {
    const h = ready();
    await edit(h, { Name: 'Grace', Email: 'g@example.com', Notes: 'n'.repeat(200) });
    const sent = h.client.editRecord.mock.calls[0]?.[3] as Record<string, string>;
    const detail = h.confirms.find((spec) => spec.title.includes('change a record'))!.detail;
    expect(Object.keys(sent).sort()).toEqual(['Email', 'Name', 'Notes']);
    for (const [field, value] of Object.entries(sent)) {
      expect(detail).toContain(`"${field}"`);
      expect(detail).toContain(`-> "${value}"`);
    }
  });

  it('a call whose values already match reads one record, asks nothing and uses no write attempt', async () => {
    const h = ready();
    expect(await edit(h, { Name: 'Ada' })).toMatchObject({ changed: false });
    expect(h.service.status()).toMatchObject({ recordsUsed: 1, writesUsed: 0 });
    expect(h.confirms.filter((spec) => spec.title.includes('change'))).toHaveLength(0);
  });

  it('writes nothing and says so when the user declines', async () => {
    const h = ready();
    h.confirm.mockImplementation(async (spec) => (h.confirms.push(spec), spec.title.includes('change a record') ? false : true));
    const result = await edit(h, { Name: 'Grace' });
    expect(result).toMatchObject({ written: false });
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.audit.at(-1)).toMatchObject({ outcome: 'declined', confirmed: false });
  });

  it('refuses the write when the record changed between the confirm-time read and the write (error 306)', async () => {
    const h = ready();
    h.confirm.mockImplementation(async (spec) => {
      h.confirms.push(spec);
      if (spec.title.includes('change a record')) h.records.get('1')!.modId = '4'; // a person edits meanwhile
      return true;
    });
    const message = await failure(edit(h, { Name: 'Grace' }));
    expect(message).toMatch(/changed by someone else/);
    expect(h.records.get('1')!.fieldData.Name).toBe('Ada');
  });

  it('does not ask or write when nothing would change', async () => {
    const h = ready();
    expect(await edit(h, { Name: 'Ada' })).toMatchObject({ changed: false });
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.confirms.filter((spec) => spec.title.includes('change'))).toHaveLength(0);
  });

  it('dry run returns old and new values through consent, quota and redaction, and never asks or writes', async () => {
    const h = makeHarness(); // no preset layout, so consent is needed
    const result = await edit(h, { Notes: 'fresh' }, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.changes).toEqual([{ field: 'Notes', old: 'see Bearer ***', new: 'fresh' }]);
    expect(h.confirms.map((spec) => spec.title)).toEqual(['Allow an AI tool to read this layout?']);
    expect(h.service.status().recordsUsed).toBe(1);
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.service.status().writesUsed).toBe(0);
  });

  it('dry run never shows a hidden field: it is refused as unknown', async () => {
    const h = ready();
    h.settings.hiddenFields = ['Salary'];
    expect(await failure(edit(h, { Salary: '1' }, { dryRun: true }))).toMatch(/Unknown or unavailable field/);
    expect(h.client.getRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['a related field', { 'Orders::Total': '1' }, /Related-record/],
    ['a field with :: in any position', { 'A::B::C': '1' }, /Related-record/],
    ['a hidden field', { Salary: '1' }, /Unknown or unavailable/],
    ['an unknown field', { Zip: '1' }, /Unknown or unavailable/],
    ['a container field', { Photo: 'x' }, /Container/],
    ['the redaction marker', { Name: 'a ***' }, /may not contain/],
    ['the hidden marker', { Name: '[hidden]' }, /may not contain/],
    ['a NUL character', { Name: 'a\0b' }, /NUL/],
    ['no fields', {}, /At least one field/]
  ])('refuses %s', async (_label, fields, pattern) => {
    const h = makeHarness({ settings: { hiddenFields: ['Salary'] } });
    h.settings.readableLayouts = { p1: ['Contacts'] };
    expect(await failure(edit(h, fields as Record<string, string>))).toMatch(pattern);
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.client.getRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['portalData', { portalData: {} }],
    ['script', { script: 'Evil' }],
    ['script.param', { 'script.param': 'x' }],
    ['a second record id', { recordIds: ['1', '2'] }],
    ['numbers as values', { fields: { Name: 5 } }]
  ])('rejects %s in the input schema', async (_label, extra) => {
    const h = ready();
    await expect(h.service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1', fields: { Name: 'x' }, ...extra })).rejects.toThrow();
    expect(h.client.editRecord).not.toHaveBeenCalled();
  });
});

describe('fm_create_record', () => {
  it('shows the new values, creates one record, and refuses related fields', async () => {
    const h = ready();
    const result = (await h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'New' }, description: 'why' })) as Record<string, unknown>;
    expect(result).toMatchObject({ written: true, recordId: '99' });
    expect(h.confirms.at(-1)?.detail).toContain('"Name": "New"');
    expect(await failure(h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { 'Orders::Total': '1' } }))).toMatch(/Related-record/);
  });

  it('writes nothing if declined, and a dry run neither asks nor writes', async () => {
    const h = ready();
    h.confirm.mockResolvedValue(false);
    expect(await h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'x' } })).toMatchObject({ written: false });
    expect(h.client.createRecord).not.toHaveBeenCalled();

    const h2 = ready();
    expect(await h2.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'x' }, dryRun: true })).toMatchObject({ dryRun: true });
    expect(h2.confirm).not.toHaveBeenCalled();
    expect(h2.client.createRecord).not.toHaveBeenCalled();
  });
});

describe('fm_delete_record', () => {
  const del = (h: Harness, extra: Record<string, unknown> = {}) =>
    h.service.invoke('fm_delete_record', { layout: 'Contacts', recordId: '1', ...extra }) as Promise<Record<string, unknown>>;

  it('shows a fresh snapshot, asks for the record id, then deletes', async () => {
    const h = ready();
    h.input.mockResolvedValue('1');
    expect(await del(h)).toEqual({ recordId: '1', deleted: true });
    expect(h.confirms.at(-1)?.detail).toContain('The record as it is now (first 5 of 5 fields):');
    expect(h.confirms.at(-1)?.detail).toContain('"Name": "Ada"');
    expect(h.input.mock.calls[0]?.[0].prompt).toContain('Type the record id 1');
    expect(h.client.deleteRecord).toHaveBeenCalledTimes(1);
  });

  it('refuses when the input box is dismissed', async () => {
    const h = ready();
    h.input.mockResolvedValue(undefined);
    expect(await del(h)).toMatchObject({ deleted: false });
    expect(h.client.deleteRecord).not.toHaveBeenCalled();
    expect(h.audit.at(-1)).toMatchObject({ outcome: 'declined', confirmed: false });
  });

  it.each(['2', '', ' 11', 'yes', '1; 2'])('refuses when the user types %j', async (typed) => {
    const h = ready();
    h.input.mockResolvedValue(typed);
    expect(await del(h)).toMatchObject({ deleted: false });
    expect(h.client.deleteRecord).not.toHaveBeenCalled();
  });

  it('does not ask for the id when the first dialog is declined', async () => {
    const h = ready();
    h.confirm.mockResolvedValue(false);
    await del(h);
    expect(h.input).not.toHaveBeenCalled();
    expect(h.client.deleteRecord).not.toHaveBeenCalled();
  });

  it('refuses if the record changed while the user was deciding', async () => {
    const h = ready();
    h.input.mockImplementation(async () => {
      h.records.get('1')!.modId = '9';
      return '1';
    });
    expect(await failure(del(h))).toMatch(/changed while/);
    expect(h.client.deleteRecord).not.toHaveBeenCalled();
  });

  it('hides hidden fields from the snapshot, and a dry run deletes nothing', async () => {
    const h = ready();
    h.settings.hiddenFields = ['Salary'];
    const result = (await del(h, { dryRun: true })) as { wouldDelete: Record<string, unknown> };
    expect(JSON.stringify(result)).not.toContain('Salary');
    expect(h.confirms.at(-1)?.detail ?? '').not.toContain('Salary');
    expect(h.client.deleteRecord).not.toHaveBeenCalled();
    expect(h.input).not.toHaveBeenCalled();
  });
});

describe('fm_run_script', () => {
  it.each([
    ['.', '..', 'The script name "." cannot be used in a request (a web address treats it as a folder reference). Rename it in FileMaker.'],
    ['..', 'Contacts', 'The script name ".." cannot be used in a request (a web address treats it as a folder reference). Rename it in FileMaker.'],
    ['Archive Old', '.', 'The layout name "." cannot be used in a request (a web address treats it as a folder reference). Rename it in FileMaker.'],
    ['Archive Old', '..', 'The layout name ".." cannot be used in a request (a web address treats it as a folder reference). Rename it in FileMaker.']
  ])('keeps the exact dot-name refusal for script %j and layout %j', async (script, layout, message) => {
    const h = makeHarness();
    expect(await failure(h.service.invoke('fm_run_script', { script, layout }))).toBe(message);
    expect(h.client.runScript).not.toHaveBeenCalled();
    expect(h.client.listScripts).not.toHaveBeenCalled();
  });

  const run = (h: Harness, extra: Record<string, unknown> = {}) =>
    h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Archive Old', ...extra }) as Promise<Record<string, unknown>>;

  it('runs an allowlisted script after the user confirms, showing script, parameter and account', async () => {
    const h = ready();
    const result = await run(h, { parameter: 'x\ny', description: 'Because' });
    expect(result).toMatchObject({ ran: true, scriptResult: 'done' });
    const detail = h.confirms.at(-1)!.detail;
    expect(detail).toContain('Script (runs as the account above): "Archive Old"');
    expect(detail).toContain('Parameter: "x\\ny"');
    expect(detail).toContain('Account: "ai_reader"');
    expect(h.confirms.at(-1)!.message).toMatch(/does not say what the script does/);
    expect(h.client.runScript).toHaveBeenCalledWith(
      expect.anything(), { layout: 'Contacts', scriptName: 'Archive Old', scriptParam: 'x\ny' }, expect.anything()
    );
  });

  it('refuses a script that is not on the allowlist before asking anything', async () => {
    const h = ready();
    expect(await failure(run(h, { script: 'Other Script' }))).toMatch(/not on the user's allowlist/);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.client.runScript).not.toHaveBeenCalled();
  });

  it('matches names exactly: case, spaces and another connection\'s allowlist do not count', async () => {
    const h = ready();
    h.settings.scriptAllowlist = { p1: ['Archive Old'], other: ['Other Script'] };
    for (const script of ['archive old', 'Archive Old ', 'Other Script']) {
      expect(await failure(run(h, { script })), script).toMatch(/allowlist/);
    }
    h.settings.scriptAllowlist = {};
    expect(await failure(run(h))).toMatch(/allowlist/);
  });

  it('refuses an allowlisted script that no longer exists, and runs nothing when declined', async () => {
    const h = ready();
    h.client.listScripts.mockResolvedValue(['Something Else']);
    expect(await failure(run(h))).toMatch(/does not exist/);

    const h2 = ready();
    h2.confirm.mockImplementation(async (spec) => (h2.confirms.push(spec), !spec.title.includes('run a script')));
    expect(await run(h2)).toMatchObject({ ran: false });
    expect(h2.client.runScript).not.toHaveBeenCalled();
  });

  it('redacts and caps the script result', async () => {
    const h = ready();
    h.client.runScript.mockResolvedValue({ messages: [], response: { scriptResult: `token Bearer abcdef123456 ${'z'.repeat(20000)}`, scriptError: '0' } });
    const result = (await run(h)) as { scriptResult: string };
    expect(result.scriptResult).toContain('Bearer ***');
    expect(result.scriptResult).not.toContain('abcdef123456');
    expect(result.scriptResult.length).toBeLessThanOrEqual(10_000);
  });
});

describe('write caps', () => {
  it(`allows ${WRITES_PER_MINUTE} write attempts per minute, then recovers`, async () => {
    const h = ready();
    for (let index = 0; index < WRITES_PER_MINUTE; index += 1) {
      await h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: `n${index}` } });
    }
    expect(await failure(h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'x' } }))).toMatch(/per minute/);
    expect(h.client.createRecord).toHaveBeenCalledTimes(WRITES_PER_MINUTE);
    h.state.now += 61_000;
    await expect(h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'later' } })).resolves.toBeDefined();
  });

  it(`stops at ${WRITES_PER_SESSION} attempts per session, counts declined ones, and shows the counter`, async () => {
    const h = ready();
    h.confirm.mockResolvedValue(false);
    h.settings.readableLayouts = { p1: ['Contacts'] };
    for (let index = 0; index < WRITES_PER_SESSION; index += 1) {
      h.state.now += 61_000; // stay under the per-minute cap
      await h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'x' } });
    }
    expect(h.service.status()).toMatchObject({ writesUsed: WRITES_PER_SESSION, writeCap: WRITES_PER_SESSION });
    h.state.now += 61_000;
    expect(await failure(h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'x' } }))).toMatch(/Write cap reached/);
  });

  it('script runs share the same write caps', async () => {
    const h = ready();
    for (let index = 0; index < WRITES_PER_MINUTE; index += 1) {
      await h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Archive Old' });
    }
    expect(await failure(h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Archive Old' }))).toMatch(/per minute/);
  });
});

describe('audit of writes', () => {
  it('logs the tool, layout and record id, never field values', async () => {
    const h = ready();
    await edit(h, { Name: 'TopSecretValue' });
    const entry = h.audit.at(-1)!;
    expect(entry).toMatchObject({ tool: 'fm_edit_record', layout: 'Contacts', recordIds: ['1'], outcome: 'ok', confirmed: true });
    expect(JSON.stringify(h.audit)).not.toContain('TopSecretValue');
  });
});
