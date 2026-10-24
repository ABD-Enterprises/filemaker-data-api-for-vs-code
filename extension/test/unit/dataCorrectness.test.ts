import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { afterEach, expect, it, vi } from 'vitest';
import { BatchService, parseBatchUpdateInput } from '../../src/services/batchService';
import { numericText } from '../../src/utils/numericText';
import { FMClient } from '../../src/services/fmClient';
import { exportRow } from '../../src/utils/exportRecords';

const profile = { id: 'p', authMode: 'direct' } as never;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function folder() { const dir = await mkdtemp(join(tmpdir(), 'correctness-')); dirs.push(dir); return dir; }
const values = ['9067.70', '-1843.00', '9007199254740993', '-0', ' ', '{"a":1}', '[]', 'null', 'true'];

it('CSV preserves exact strings including whitespace and JSON-looking text', () => {
  for (const value of values) {
    const csv = `recordId, Text \n1,"${value.replace(/"/g, '""')}"\n`;
    expect(parseBatchUpdateInput(csv, 'csv')[0]!.fieldData[' Text ']).toBe(value);
  }
});

it('CSV rejects ambiguous duplicate metadata, JSONL and semicolon files clearly', () => {
  expect(() => parseBatchUpdateInput('recordId,recordId,Name\n1,2,A', 'csv')).toThrow(/ambiguous/i);
  expect(() => parseBatchUpdateInput('{"recordId":"1","fieldData":{"Name":"A"}}\n', 'csv')).toThrow(/looks like a JSONL file/);
  expect(() => parseBatchUpdateInput('recordId;Name\n1;A', 'csv')).toThrow(/semicolon-delimited/);
});

it('batch uses metadata once, keeps text exact and warns per unsafe numeric row', async () => {
  const editRecord = vi.fn().mockResolvedValue({});
  const getLayoutMetadata = vi.fn().mockResolvedValue({ fieldMetaData: [
    { name: ' Text ', result: 'text' }, { name: 'Number', result: 'number' }, { name: 'Date', result: 'date' }
  ] });
  const service = new BatchService({ editRecord, getLayoutMetadata } as never);
  const log = vi.fn();
  await service.batchUpdate(profile, ' Layout ', parseBatchUpdateInput('recordId, Text ,Number,Date\n1,10.50,10.50,10.50\n2, ,9007199254740993,2026-10-21', 'csv'), { dryRun: false },
    { log, isCancellationRequested: () => false, reportProgress: vi.fn() } as never);
  expect(getLayoutMetadata).toHaveBeenCalledTimes(1);
  expect(editRecord).toHaveBeenCalledWith(profile, ' Layout ', '1', { ' Text ': '10.50', Number: 10.5, Date: '10.50' });
  expect(editRecord).toHaveBeenCalledWith(profile, ' Layout ', '2', { ' Text ': ' ', Number: '9007199254740993', Date: '2026-10-21' });
  expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/2.*Number/));
});

it('Record Editor uses field result type rather than JSON guesses', async () => {
  const source = await readFile(join(__dirname, '../../src/webviews/recordEditor/ui/index.js'), 'utf8');
  const fn = source.slice(source.indexOf('function parseEditableValue('), source.indexOf('\nfunction clone('));
  const helpers = source.slice(source.indexOf('function metadataForField('), source.indexOf('function readOnlyNote('));
  const parse = runInNewContext(`${helpers}\n${fn}; parseEditableValue`, { state: { presentationFields: [{ name: 'Text', type: 'text' }, { name: 'Number', type: 'number' }] } });
  for (const value of values) expect(parse(value, 'Text')).toBe(value);
  expect(parse('10.50', 'Number')).toBe(10.5);
  expect(parse('9007199254740993', 'Number')).toBe('9007199254740993');
  for (const value of ['10.50', '.5', '1.', '+1e2', '-0', '9007199254740991', '9007199254740991.0', '9007199254740991.1', '9.0071992547409911e15', '9007199254740992', '10000000000000000', '10000000000000000000', '1e309', '1e-999', 'NaN', 'Infinity', ' ', 'true']) {
    expect(parse(value, 'Number')).toBe(numericText(value));
  }
  expect(parse('9007199254740991.1', 'Number')).toBe('9007199254740991.1');
  expect(parse('9.007199254740991e15', 'Number')).toBe(9007199254740991);
  expect(parse('1e-999', 'Number')).toBe('1e-999');
  expect(parse('10000000000000000', 'Number')).toBe('10000000000000000');
  expect(parse('10000000000000000000', 'Number')).toBe('10000000000000000000');
});

it.each(['10000000000000000', '10000000000000000000', '-10000000000000000', '-10000000000000000000'])('keeps overflowing integer %s as exact text', (value) => {
  expect(numericText(value)).toBe(value);
});

it('refuses export column collisions before a field can overwrite a record identifier', () => {
  expect(() => exportRow({ recordId: '42', fieldData: { RecordID: 'field value' } }, ['recordId', 'modId'])).toThrow(/Export column collision.*RecordID/);
  expect(() => exportRow({ recordId: '42', fieldData: { '__portalNote (export information)': 'field value' } }, ['recordId', 'modId'], '__portalNote (export information)')).toThrow(/Export column collision/);
});

it('expands repeating metadata and appends unexpected first-page keys in encounter order', async () => {
  const dir = await folder(); const path = join(dir, 'repeats.csv');
  const rows = [
    { recordId: '1', fieldData: { 'Phones(1)': '111', 'Phones(2)': '222', 'Phones(3)': '333', 'Related::Odd key': 'related' } },
    { recordId: '2', fieldData: { 'Phones(1)': '444', recordId: 'field id' } }
  ];
  const service = new BatchService({
    getLayoutMetadata: vi.fn().mockResolvedValue({ fieldMetaData: [{ name: 'Phones', result: 'text', maxRepeat: 3 }] }),
    findRecords: vi.fn().mockResolvedValue({ data: rows })
  } as never);
  const result = await service.batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format: 'csv', maxRecords: 100 });
  const csv = await readFile(path, 'utf8');
  expect(csv.split('\n')[0]).toBe('__recordId,__modId,Phones(1),Phones(2),Phones(3),Related::Odd key,recordId');
  expect(parseBatchUpdateInput(csv, 'csv')).toEqual(rows);
  expect(result.unknownColumnValues).toBeUndefined();
});

it('counts every omitted late value, and keeps the exact unknown column names in the job result', async () => {
  const dir = await folder(); const path = join(dir, 'late.csv');
  const findRecords = vi.fn()
    .mockResolvedValueOnce({ data: [{ recordId: '1', fieldData: { Name: 'A' } }] })
    .mockResolvedValueOnce({ data: [{ recordId: '2', fieldData: { Name: 'B', 'Related::Odd key': 'one', Other: 'two' } }] })
    .mockResolvedValueOnce({ data: [{ recordId: '3', fieldData: { Name: 'C', 'Related::Odd key': 'three' } }] })
    .mockResolvedValueOnce({ data: [] });
  const log = vi.fn();
  const service = new BatchService({ findRecords, getLayoutMetadata: vi.fn().mockResolvedValue({ fieldMetaData: [{ name: 'Name', result: 'text' }] }) } as never);
  const result = await service.batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format: 'csv', pageSize: 1, maxRecords: 100 }, { log, reportProgress: vi.fn(), isCancellationRequested: () => false });
  expect(result).toMatchObject({ exportedRecords: 3, unknownColumnValues: 3, warnings: ['3 values were not exported because their columns were unknown: "Related::Odd key", "Other".'] });
  expect(log).toHaveBeenCalledWith('warn', result.warnings![0]);
  expect(await readFile(path, 'utf8')).toBe('recordId,modId,Name\n1,,A\n2,,B\n3,,C\n');
});

it.each(['csv', 'jsonl'] as const)('failed %s export preserves destination and removes temporary files', async (format) => {
  const dir = await folder(); const path = join(dir, `out.${format}`);
  await writeFile(path, 'original');
  const service = new BatchService({ findRecords: vi.fn().mockRejectedValue(new Error('failed find')) } as never);
  await expect(service.batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format, maxRecords: 100 })).rejects.toThrow('failed find');
  expect(await readFile(path, 'utf8')).toBe('original');
  expect(await readdir(dir)).toEqual([`out.${format}`]);
});

it('CSV metadata columns precede digit fields, collisions round-trip, missing first-row fields survive', async () => {
  const dir = await folder(); const path = join(dir, 'out.csv');
  const getLayoutMetadata = vi.fn().mockResolvedValue({ fieldMetaData: ['recordId', 'modId', '123', 'Later', 'Unseen'].map((name) => ({ name, result: 'text' })) });
  const service = new BatchService({ getLayoutMetadata, findRecords: vi.fn().mockResolvedValue({ data: [
    { recordId: 'real1', modId: '7', fieldData: { recordId: 'field1', modId: 'fieldmod', '123': 'digits' } },
    { recordId: 'real2', modId: '8', fieldData: { Later: 'later' } }
  ] }) } as never);
  await service.batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format: 'csv', maxRecords: 100 });
  const csv = await readFile(path, 'utf8');
  expect(csv.split('\n')[0]).toBe('__recordId,__modId,recordId,modId,123,Later,Unseen');
  expect(parseBatchUpdateInput(csv, 'csv')).toEqual([
    { recordId: 'real1', modId: '7', fieldData: { recordId: 'field1', modId: 'fieldmod', '123': 'digits' } },
    { recordId: 'real2', modId: '8', fieldData: { Later: 'later' } }
  ]);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('empty CSV writes metadata header, and Excel option adds BOM', async () => {
  const dir = await folder(); const path = join(dir, 'out.csv');
  const service = new BatchService({ getLayoutMetadata: vi.fn().mockResolvedValue({ fieldMetaData: [{ name: 'Café', result: 'text' }] }), findRecords: vi.fn().mockResolvedValue({ data: [] }) } as never);
  await service.batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format: 'csv', maxRecords: 100, excelCompatible: true } as never);
  expect(await readFile(path, 'utf8')).toBe('\uFEFFrecordId,modId,Café\n');
});

it('client retains portal counts for get and find and sends exact portal paging keys', async () => {
  const portalDataInfo = [{ portalObjectName: ' Orders ', foundCount: 170, returnedCount: 50 }];
  const response = { data: [{ recordId: '1', fieldData: {}, portalData: { ' Orders ': Array.from({ length: 50 }, (_, i) => ({ recordId: String(i) })) } }], dataInfo: { portalDataInfo } };
  const requestWithAuth = vi.fn().mockResolvedValue({ response });
  const client = Object.assign(Object.create(FMClient.prototype), { withHistory: (_: unknown, fn: (trace: object) => unknown) => fn({}), requestWithAuth, logger: { warn: vi.fn() } });
  const record = await client.getRecord(profile, ' Layout ', '1', { portal: { ' Orders ': { limit: 50, offset: 51 } } });
  expect(record.portalDataInfo).toEqual(portalDataInfo);
  expect(requestWithAuth.mock.calls[0]![1].params).toEqual({ '_limit. Orders ': 50, '_offset. Orders ': 51 });
  const result = await client.findRecords(profile, ' Layout ', { query: [{ Name: '*' }], portal: { ' Orders ': { limit: 50, offset: 51 } } });
  expect(result.data[0].portalDataInfo).toEqual(portalDataInfo);
  expect(requestWithAuth.mock.calls[1]![1].data).toMatchObject({ 'limit. Orders ': 50, 'offset. Orders ': 51 });
});

it('missing metadata keeps CSV values as strings and warns', async () => {
  const editRecord = vi.fn().mockResolvedValue({}); const log = vi.fn();
  const service = new BatchService({ editRecord, getLayoutMetadata: vi.fn().mockRejectedValue(new Error('unavailable')) } as never);
  await service.batchUpdate(profile, 'Layout', parseBatchUpdateInput('recordId,Number\n1,10.50', 'csv'), { dryRun: false }, { log, isCancellationRequested: () => false, reportProgress: vi.fn() } as never);
  expect(editRecord).toHaveBeenCalledWith(profile, 'Layout', '1', { Number: '10.50' });
  expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('strings'));
});

it.each(['csv', 'jsonl'] as const)('cancelled %s export leaves original and no partial files', async (format) => {
  const dir = await folder(); const path = join(dir, `out.${format}`); await writeFile(path, 'original');
  let cancelled = false;
  const findRecords = vi.fn(async () => { cancelled = true; return { data: [{ recordId: '1', fieldData: { Name: 'A' } }] }; });
  const result = await new BatchService({ findRecords, getLayoutMetadata: vi.fn().mockResolvedValue({ fieldMetaData: [{ name: 'Name', result: 'text' }] }) } as never).batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format, maxRecords: 100 }, { log: vi.fn(), reportProgress: vi.fn(), isCancellationRequested: () => cancelled } as never);
  expect(result).toMatchObject({ exportedRecords: 0, cancelled: true, truncated: false });
  expect(await readFile(path, 'utf8')).toBe('original');
  expect(await readdir(dir)).toEqual([`out.${format}`]);
});

it.each(['csv', 'jsonl'] as const)('%s export includes an honest portal truncation note', async (format) => {
  const dir = await folder(); const path = join(dir, `out.${format}`);
  const record = { recordId: '1', fieldData: { Name: 'A' }, portalDataInfo: [{ portalObjectName: ' Orders ', foundCount: 170, returnedCount: 50 }] };
  await new BatchService({ findRecords: vi.fn().mockResolvedValue({ data: [record] }) } as never).batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format, maxRecords: 100 });
  expect(await readFile(path, 'utf8')).toContain(' Orders : showing 50 of 170');
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('metadata-free CSV sampling spans pages and preserves later collision fields', async () => {
  const dir = await folder(); const path = join(dir, 'sample.csv');
  const findRecords = vi.fn().mockResolvedValueOnce({ data: [{ recordId: '1', fieldData: { Name: 'A' } }] })
    .mockResolvedValueOnce({ data: [{ recordId: '2', fieldData: { recordId: 'field', Later: 'B' } }] })
    .mockResolvedValueOnce({ data: [] });
  await new BatchService({ findRecords } as never).batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format: 'csv', maxRecords: 100, pageSize: 1 });
  const csv = await readFile(path, 'utf8');
  expect(csv.split('\n')[0]).toBe('__recordId,__modId,Name,recordId,Later');
  expect(parseBatchUpdateInput(csv, 'csv')[1]).toEqual({ recordId: '2', fieldData: { recordId: 'field', Later: 'B' } });
});

it.each(['csv', 'jsonl'] as const)('failed later %s page removes partial temporary data', async (format) => {
  const dir = await folder(); const path = join(dir, `later.${format}`); await writeFile(path, 'original');
  const findRecords = vi.fn().mockResolvedValueOnce({ data: [{ recordId: '1', fieldData: { Name: 'A' } }] }).mockRejectedValueOnce(new Error('second page failed'));
  const service = new BatchService({ findRecords, getLayoutMetadata: vi.fn().mockResolvedValue({ fieldMetaData: [{ name: 'Name', result: 'text' }] }) } as never);
  await expect(service.batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format, maxRecords: 100, pageSize: 1 })).rejects.toThrow('second page failed');
  expect(await readFile(path, 'utf8')).toBe('original');
  expect(await readdir(dir)).toEqual([`later.${format}`]);
});

it('rejects moved reserved columns rather than editing a record named by a field', () => {
  expect(() => parseBatchUpdateInput('Name,__recordId,__modId,recordId,modId\nA,42,1,field,fieldmod', 'csv')).toThrow(/ambiguous/i);
  expect(() => parseBatchUpdateInput('__recordId,Name,__modId,recordId,modId\n42,A,1,field,fieldmod', 'csv')).toThrow(/ambiguous/i);
});

it('uses extra underscores when reserved names are real fields too', async () => {
  const dir = await folder(); const path = join(dir, 'reserved.csv');
  const fields = { RecordID: 'field', __recordId: 'reserved field', __modId: 'reserved mod', '__portalNote (export information)': 'a real field' };
  await new BatchService({ getLayoutMetadata: vi.fn().mockResolvedValue({ fields: Object.keys(fields).map((name) => ({ name, result: 'text' })) }), findRecords: vi.fn().mockResolvedValue({ data: [{ recordId: '42', modId: '7', fieldData: fields }] }) } as never)
    .batchExportFind(profile, 'Layout', { query: [{}] }, { outputPath: path, format: 'csv', maxRecords: 100 });
  const csv = await readFile(path, 'utf8');
  expect(csv).toMatch(/^___recordId,___modId,/);
  expect(parseBatchUpdateInput(csv, 'csv')).toEqual([{ recordId: '42', modId: '7', fieldData: fields }]);
});

it('recognizes semicolon CSV with quoted commas, and JSONL selected through the JSON path', () => {
  expect(() => parseBatchUpdateInput('recordId;"Last, First"\n1;"Élie, Jo"', 'csv')).toThrow(/semicolon-delimited/);
  expect(() => parseBatchUpdateInput('{"recordId":"1","fieldData":{}}\n{"recordId":"2","fieldData":{}}\n', 'json')).toThrow(/looks like a JSONL file/);
  expect(() => parseBatchUpdateInput('{"recordId":"1","fieldData":{}}', 'json')).toThrow('Batch update JSON must be an array.');
});

it('proxy portal paging gives a clear direct-connection explanation', async () => {
  const getRecord = vi.fn().mockResolvedValue({ recordId: '1', fieldData: {} });
  const client = Object.assign(Object.create(FMClient.prototype), { withHistory: (_: unknown, fn: (trace: object) => unknown) => fn({}), proxyClient: { getRecord } });
  await expect(client.getRecord({ id: 'p', authMode: 'proxy' }, ' Layout ', '1', { portal: { ' Orders ': { limit: 100 } } })).rejects.toThrow(/proxy.*direct connection/);
  expect(getRecord).not.toHaveBeenCalled();
});

it('refuses an old ambiguous CSV when the layout has a recordId field, before editing anything', async () => {
  const editRecord = vi.fn().mockResolvedValue({});
  const service = new BatchService({ editRecord, getLayoutMetadata: vi.fn().mockResolvedValue({ fieldMetaData: [{ name: 'recordId', result: 'text' }, { name: 'Name', result: 'text' }] }) } as never);
  await expect(service.batchUpdate(profile, 'Layout', parseBatchUpdateInput('recordId,modId,Name\n99,fieldmod,A', 'csv'), { dryRun: false })).rejects.toThrow(/ambiguous.*reserved/i);
  expect(editRecord).not.toHaveBeenCalled();
});

it.each([false, true])('batch CSV adds a portal note only for actual truncation, including on later pages: %s', async (truncated) => {
  const path = join(await folder(), 'optional-note.csv');
  const findRecords = vi.fn().mockResolvedValueOnce({ data: [{ recordId: '1', fieldData: { Name: 'first' } }] })
    .mockResolvedValueOnce({ data: [{ recordId: '2', fieldData: { Name: 'second' }, portalDataInfo: [{ portalObjectName: 'Lines', foundCount: truncated ? 3 : 1, returnedCount: 1 }] }] })
    .mockResolvedValue({ data: [] });
  await new BatchService({ findRecords, getLayoutMetadata: async () => ({ fieldMetaData: [{ name: 'Name', result: 'text' }] }) } as never)
    .batchExportFind(profile, 'Layout', { query: [{ Name: '*' }] }, { outputPath: path, format: 'csv', pageSize: 1, maxRecords: 10 });
  const csv = await readFile(path, 'utf8');
  expect(csv).toBe(truncated ? 'recordId,modId,Name,__portalNote (export information)\n1,,first,\n2,,second,Lines: showing 1 of 3\n' : 'recordId,modId,Name\n1,,first\n2,,second\n');
});
