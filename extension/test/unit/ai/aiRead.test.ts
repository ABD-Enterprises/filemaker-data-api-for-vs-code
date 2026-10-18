/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';

import { MAX_RESULT_CHARS, SESSION_RECORD_QUOTA } from '../../../src/ai/aiToolService';
import type { FileMakerRecord } from '../../../src/types/fm';
import { failure, makeHarness, SECRET_HOST } from './harness';

type Result = Record<string, unknown> & { records?: Array<Record<string, any>>; fields?: Array<Record<string, any>> };

const find = (h: ReturnType<typeof makeHarness>, extra: Record<string, unknown> = {}) =>
  h.service.invoke('fm_find_records', { layout: 'Contacts', requests: [{ fields: { Name: 'Ada' } }], ...extra }) as Promise<Result>;

describe('listing', () => {
  it('lists layouts and scripts, flagging names the tools cannot use', async () => {
    const h = makeHarness();
    const layouts = (await h.service.invoke('fm_list_layouts', {})) as Result;
    expect(layouts).toMatchObject({
      layouts: [
        { name: 'Contacts', usable: true },
        { name: 'Orders', usable: true },
        { name: '[name omitted]', usable: false }
      ],
      count: 3
    });
    const scripts = (await h.service.invoke('fm_list_scripts', {})) as Result;
    expect(JSON.stringify(scripts)).not.toContain('Bad`Script');
    expect(JSON.stringify(scripts)).toContain('Archive Old');
  });

  it('never includes the server address, user name or account in any result', async () => {
    const h = makeHarness();
    h.settings.readableLayouts = { p1: ['Contacts'] };
    const outputs = [
      await h.service.invoke('fm_list_layouts', {}),
      await h.service.invoke('fm_list_scripts', {}),
      await h.service.invoke('fm_describe_layout', { layout: 'Contacts' }),
      await find(h),
      await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' })
    ];
    const text = JSON.stringify(outputs);
    for (const secret of [SECRET_HOST, '16000', 'ai_reader', 'https://secret']) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

describe('layout consent', () => {
  it('asks once per session, naming the layout as a JSON-escaped, capped string', async () => {
    const h = makeHarness();
    await h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' });
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirms[0]?.message).toContain('layout "Contacts"');
    expect(h.confirms[0]?.message).toContain('"Dev Server"');
    expect(h.confirms[0]?.detail).toMatch(/related and portal data/);
    expect(h.confirms[0]?.detail).toMatch(/model provider/);
  });

  it('does not ask for a layout listed in readableLayouts for that connection only', async () => {
    const h = makeHarness();
    h.settings.readableLayouts = { p1: ['Contacts'], other: ['Orders'] };
    await h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    expect(h.confirm).not.toHaveBeenCalled();
    await h.service.invoke('fm_describe_layout', { layout: 'Orders' });
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it('refuses without reading when the user says no, and does not ask again', async () => {
    const h = makeHarness();
    h.confirm.mockResolvedValueOnce(false);
    expect(await failure(h.service.invoke('fm_find_records', { layout: 'Contacts', requests: [{ fields: { Name: 'a' } }] }))).toMatch(/did not allow/);
    expect(await failure(h.service.invoke('fm_describe_layout', { layout: 'Contacts' }))).toMatch(/did not allow/);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.client.findRecords).not.toHaveBeenCalled();
    expect(h.schema.getLayoutSchema).not.toHaveBeenCalled();
    expect(h.audit.at(0)?.outcome).toBe('declined');
  });

  it('rejects an unknown layout and a layout whose name tools cannot use', async () => {
    const h = makeHarness();
    expect(await failure(h.service.invoke('fm_describe_layout', { layout: 'Nope' }))).toMatch(/Unknown layout/);
    expect(await failure(h.service.invoke('fm_describe_layout', { layout: 'Odd/Layout' }))).toMatch(/cannot be used/);
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe('fm_describe_layout', () => {
  it('returns field names and types, without hidden fields and without unsafe names', async () => {
    const h = makeHarness();
    h.settings.readableLayouts = { p1: ['Contacts'] };
    h.settings.hiddenFields = ['salary'];
    h.layoutFields.push({ name: 'Evil\nname', result: 'text' });
    const result = (await h.service.invoke('fm_describe_layout', { layout: 'Contacts' })) as Result;
    const names = result.fields?.map((field) => field.name);
    expect(names).toEqual(['Name', 'Email', 'Photo', 'Notes', 'Orders::Total']);
    expect(JSON.stringify(result)).not.toMatch(/Salary|Evil/i);
  });

  it('refuses when metadata is not available', async () => {
    const h = makeHarness();
    h.settings.readableLayouts = { p1: ['Contacts'] };
    h.schema.getLayoutSchema.mockResolvedValue({ supported: false, fromCache: false, fields: [] });
    expect(await failure(h.service.invoke('fm_describe_layout', { layout: 'Contacts' }))).toMatch(/metadata is not available/);
  });
});

describe('fm_find_records: closed grammar', () => {
  const ready = () => {
    const h = makeHarness();
    h.settings.readableLayouts = { p1: ['Contacts'] };
    return h;
  };

  it('builds the Data API body from validated fields, omit, sort, limit and offset', async () => {
    const h = ready();
    await find(h, {
      requests: [{ fields: { Name: 'Ada', Email: '==a@x' } }, { fields: { Name: 'Bob' }, omit: true }],
      sort: [{ field: 'Name', order: 'desc' }, { field: 'Email' }],
      limit: 5,
      offset: 3
    });
    expect(h.client.findRecords).toHaveBeenCalledWith(
      expect.anything(),
      'Contacts',
      {
        query: [{ Name: 'Ada', Email: '==a@x' }, { Name: 'Bob', omit: 'true' }],
        sort: [{ fieldName: 'Name', sortOrder: 'descend' }, { fieldName: 'Email', sortOrder: 'ascend' }],
        limit: 5,
        offset: 3
      },
      expect.anything()
    );
  });

  it.each([
    ['six requests', { requests: Array.from({ length: 6 }, () => ({ fields: { Name: 'a' } })) }],
    ['no requests', { requests: [] }],
    ['a raw Data API array', { requests: [{ Name: 'a' }] }],
    ['a non-string value', { requests: [{ fields: { Name: { $ne: 1 } } }] }],
    ['a number value', { requests: [{ fields: { Name: 5 } }] }],
    ['an extra property on a request', { requests: [{ fields: { Name: 'a' }, script: 'Evil' }] }],
    ['a script top-level key', { script: 'Evil' }],
    ['portalData', { portalData: ['Orders'] }],
    ['a 201 character value', { requests: [{ fields: { Name: 'x'.repeat(201) } }] }],
    ['limit 51', { limit: 51 }],
    ['limit 0', { limit: 0 }],
    ['offset 0', { offset: 0 }],
    ['four sort keys', { sort: Array.from({ length: 4 }, () => ({ field: 'Name' })) }],
    ['a sort order that is not asc/desc', { sort: [{ field: 'Name', order: 'ascend' }] }],
    ['sort with a custom value list', { sort: [{ field: 'Name', valueList: 'x' }] }]
  ])('rejects %s without calling the server', async (_label, extra) => {
    const h = ready();
    await expect(find(h, extra)).rejects.toThrow();
    expect(h.client.findRecords).not.toHaveBeenCalled();
  });

  it('rejects an empty request and a find made only of omit requests', async () => {
    const h = ready();
    expect(await failure(find(h, { requests: [{ fields: {} }] }))).toMatch(/at least one field/);
    expect(await failure(find(h, { requests: [{ fields: { Name: 'a' }, omit: true }] }))).toMatch(/must not be an omit/);
  });

  it('validates field names against the layout, including Table::Field', async () => {
    const h = ready();
    await expect(find(h, { requests: [{ fields: { 'Orders::Total': '>5' } }] })).resolves.toBeDefined();
    for (const name of ['Nope', 'orders::total', '__proto__', 'constructor', 'Name; DROP']) {
      expect(await failure(find(h, { requests: [{ fields: { [name]: 'a' } }] })), name).toMatch(/Unknown or unavailable field/);
    }
    expect(await failure(find(h, { sort: [{ field: 'Nope' }] }))).toMatch(/Unknown or unavailable field/);
  });

  it('shows hidden fields exactly as unknown fields in criteria and sort (no probing)', async () => {
    const h = ready();
    h.settings.hiddenFields = ['Salary'];
    const hiddenCriteria = await failure(find(h, { requests: [{ fields: { Salary: '>1' } }] }));
    const unknownCriteria = await failure(find(h, { requests: [{ fields: { Zalary: '>1' } }] }));
    expect(hiddenCriteria.replace('Salary', 'X')).toBe(unknownCriteria.replace('Zalary', 'X'));
    const hiddenSort = await failure(find(h, { sort: [{ field: 'Salary' }] }));
    expect(hiddenSort).toMatch(/Unknown or unavailable/);
    expect(h.client.findRecords).not.toHaveBeenCalled();
  });

  it('hides a field named with a table prefix when the entry has none, and the reverse', async () => {
    const h = ready();
    h.settings.hiddenFields = ['Orders::Total'];
    expect(await failure(find(h, { requests: [{ fields: { 'Orders::Total': '1' } }] }))).toMatch(/Unknown or unavailable/);
    h.settings.hiddenFields = ['Total'];
    expect(await failure(find(h, { requests: [{ fields: { 'Orders::Total': '1' } }] }))).toMatch(/Unknown or unavailable/);
  });
});

describe('results', () => {
  const ready = () => {
    const h = makeHarness();
    h.settings.readableLayouts = { p1: ['Contacts'] };
    return h;
  };

  it('removes hidden fields from record data and portal rows, and omits container values', async () => {
    const h = ready();
    h.settings.hiddenFields = ['Salary'];
    const result = await find(h);
    const first = result.records?.[0] as Record<string, any>;
    expect(Object.keys(first.fields)).toEqual(['Name', 'Email', 'Photo', 'Notes']);
    expect(first.fields.Photo).toBe('[container field omitted]');
    expect(first.portals.Orders[0]).toEqual({ 'Orders::Total': '10', recordId: '9', modId: '0' });
    expect(JSON.stringify(result)).not.toMatch(/90000|Salary/);
  });

  it('redacts secrets inside values but leaves names and ordinary text alone', async () => {
    const h = ready();
    h.records.get('2')!.fieldData = { Name: 'Basic Info', Email: 'x', Salary: '1', Photo: '', Notes: 'Password Reset flow' };
    h.layoutFields.push({ name: 'Session Token', result: 'text' });
    h.records.get('2')!.fieldData['Session Token'] = 'abc';
    const result = await find(h);
    const first = result.records?.[0] as Record<string, any>;
    expect(first.fields.Notes).toBe('see Bearer ***');
    const second = result.records?.[1] as Record<string, any>;
    // Names are not redacted, so a field called "Session Token" stays visible and usable.
    expect(Object.keys(second.fields)).toContain('Session Token');
    expect(second.fields.Notes).toBe('Password Reset flow');
  });

  it('counts returned records against the session quota and shows the counter', async () => {
    const h = ready();
    const result = (await find(h)) as Result;
    expect(result.quota).toEqual({ used: 2, limit: SESSION_RECORD_QUOTA });
    await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' });
    expect(h.service.status().recordsUsed).toBe(3);
  });

  it('shrinks the limit to what is left of the quota and then refuses', async () => {
    const h = ready();
    const many: FileMakerRecord[] = Array.from({ length: 50 }, (_, index) => ({ recordId: String(index), modId: '0', fieldData: { Name: 'n' } }));
    h.client.findRecords.mockImplementation(async (_p: unknown, _l: unknown, body: { limit: number }) => ({
      data: many.slice(0, body.limit),
      dataInfo: { foundCount: 9999 }
    }));
    for (let index = 0; index < 9; index += 1) {
      await find(h, { limit: 50 });
    }
    expect(h.service.status().recordsUsed).toBe(450);
    await find(h, { limit: 50 });
    expect(h.service.status().recordsUsed).toBe(500);
    expect(await failure(find(h))).toMatch(/quota/);
    expect(await failure(h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' }))).toMatch(/quota/);
    const lastLimit = h.client.findRecords.mock.calls.at(-1)?.[2] as { limit: number };
    expect(lastLimit.limit).toBe(50);
  });

  it('never returns more than the limit even if the server does', async () => {
    const h = ready();
    const result = await find(h, { limit: 1 });
    expect(result.records).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('caps the size of a result and says it was truncated', async () => {
    const h = ready();
    const big = Array.from({ length: 50 }, (_, index) => ({
      recordId: String(index),
      modId: '0',
      fieldData: Object.fromEntries(Array.from({ length: 20 }, (_u, f) => [`F${f}`, 'y'.repeat(1900)]))
    }));
    h.layoutFields.splice(0, h.layoutFields.length, ...Array.from({ length: 20 }, (_, f) => ({ name: `F${f}`, result: 'text' })));
    h.client.findRecords.mockResolvedValue({ data: big, dataInfo: { foundCount: 50 } });
    const result = await find(h, { requests: [{ fields: { F0: 'y' } }], limit: 50 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.records!.length).toBeLessThan(50);
  });

  it('cuts one very long value', async () => {
    const h = ready();
    h.records.get('2')!.fieldData.Notes = 'z'.repeat(5000);
    const result = await find(h);
    expect(String((result.records?.[1] as any).fields.Notes)).toMatch(/…\[truncated\]$/);
  });

  it('get_record rejects a malformed id before any call', async () => {
    const h = ready();
    expect(await failure(h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '../1' }))).toMatch(/invalid format/);
    expect(h.client.getRecord).not.toHaveBeenCalled();
  });

  it('turns a client failure into a message without server details', async () => {
    const h = ready();
    h.client.findRecords.mockRejectedValue(new Error(`timeout calling https://${SECRET_HOST}:16000 as ai_reader`));
    const message = await failure(find(h));
    expect(message).not.toContain(SECRET_HOST);
    expect(message).not.toContain('ai_reader');
  });
});
