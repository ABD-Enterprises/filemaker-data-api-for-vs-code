import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { BatchService, parseBatchUpdateInput } from '../../../src/services/batchService';
import { FMClientError } from '../../../src/services/errors';
import type { FMClient } from '../../../src/services/fmClient';

const profile = { id: 'p', name: 'P', serverUrl: 'https://example.test', database: 'DB', authMode: 'direct' as const };
const fields = [
  { name: ' Name ', type: 'normal', result: 'text' },
  { name: ' Calc ', type: 'calculation', result: 'number' },
  { name: 'Summary', type: 'summary', result: 'number' },
  { name: 'Global', type: 'normal', global: true, result: 'text' }
];
function setup() {
  const editRecord = vi.fn().mockResolvedValue({});
  const getLayoutMetadata = vi.fn().mockResolvedValue({ fieldMetaData: fields });
  const getRecord = vi.fn();
  const client = { editRecord, getLayoutMetadata, getRecord };
  return { ...client, service: new BatchService(client as unknown as FMClient) };
}

describe('batch update safety', () => {
  it.each(['recordId,modId', '__recordId,__modId', '___recordId,___modId'])('keeps CSV versions from %s without changing field names', (headers) => {
    expect(parseBatchUpdateInput(`${headers}, Name \n1, 7 , value `, 'csv')).toEqual([
      { recordId: '1', modId: '7', fieldData: { ' Name ': ' value ' } }
    ]);
  });
  it('keeps JSON versions, permits missing versions, and rejects invalid versions', () => {
    expect(parseBatchUpdateInput('[{"recordId":"1","modId":"0","fieldData":{}}]', 'json')[0]).toHaveProperty('modId', '0');
    expect(parseBatchUpdateInput('[{"recordId":"1","fieldData":{}}]', 'json')[0]).not.toHaveProperty('modId');
    expect(() => parseBatchUpdateInput('[{"recordId":"1","modId":{},"fieldData":{}}]', 'json')).toThrow(/modId/);
  });
  it('trims JSON record and modification IDs while preserving field names and values', async () => {
    const { service, editRecord } = setup();
    const entries = parseBatchUpdateInput(JSON.stringify([
      { recordId: ' 1\t', modId: ' 7\n', fieldData: { ' Name ': ' Ada ' } },
      { recordId: ' 2 ', modId: ' \t ', fieldData: { ' Name ': ' Grace ' } }
    ]), 'json');
    expect(entries).toEqual([
      { recordId: '1', modId: '7', fieldData: { ' Name ': ' Ada ' } },
      { recordId: '2', fieldData: { ' Name ': ' Grace ' } }
    ]);
    await service.batchUpdate(profile, ' Layout ', entries, { dryRun: false, concurrency: 1 });
    expect(editRecord).toHaveBeenNthCalledWith(1, profile, ' Layout ', '1', { ' Name ': ' Ada ' }, undefined, { modId: '7' });
    expect(editRecord).toHaveBeenNthCalledWith(2, profile, ' Layout ', '2', { ' Name ': ' Grace ' });
  });
  it.each([true, false])('ignores skipped-only rows when checking duplicates (dryRun=%s)', async (dryRun) => {
    const { service, editRecord } = setup();
    const result = await service.batchUpdate(profile, 'L', [
      { recordId: '1', fieldData: { ' Calc ': 9, Summary: 10 } },
      { recordId: '1', fieldData: { ' Name ': 'Ada' } },
      { recordId: '1', fieldData: { Summary: 11 } }
    ], { dryRun });
    expect(result.failureCount).toBe(0);
    expect(result.warnings?.some((warning) => /duplicate/i.test(warning))).toBe(false);
    expect(editRecord).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    if (!dryRun) {
      expect(result).toMatchObject({ successCount: 1, skippedReadOnlyRows: 2 });
      expect(editRecord).toHaveBeenCalledWith(profile, 'L', '1', { ' Name ': 'Ada' });
    }
  });
  it.each([
    ['10.50', '10.5'], ['1e2', 100], [10.5, '10.500'],
    ['Ada  \t', 'Ada'], ['a\r\nb\rc', 'a\nb\nc']
  ])('confirms a lost reply after FileMaker normalizes %j to %j', async (sent, stored) => {
    const { service, editRecord, getRecord } = setup();
    editRecord.mockRejectedValueOnce(new FMClientError('reply lost', { isRetryable: true }))
      .mockRejectedValueOnce(new FMClientError('stale', { code: '306' }));
    getRecord.mockResolvedValue({ fieldData: { ' Name ': stored } });
    const result = await service.batchUpdate(profile, ' Layout ', [{ recordId: '1', modId: '7', fieldData: { ' Name ': sent } }], { dryRun: false });
    expect(result).toMatchObject({ successCount: 1, failureCount: 0, skippedChanged: 0 });
    expect(getRecord).toHaveBeenCalledOnce();
    expect(editRecord).toHaveBeenCalledWith(profile, ' Layout ', '1', { ' Name ': sent }, undefined, { modId: '7' });
  });
  it.each([
    [' Ada', 'Ada'], ['9007199254740993', '9007199254740992'],
    ['', 0], [null, ''], ['a\nb', 'ab'], ['01/02/2026', '02/01/2026']
  ])('does not confirm different or ambiguous values %j and %j', async (sent, stored) => {
    const { service, editRecord, getRecord } = setup();
    editRecord.mockRejectedValueOnce(new FMClientError('reply lost', { isRetryable: true }))
      .mockRejectedValueOnce(new FMClientError('stale', { code: '306' }));
    getRecord.mockResolvedValue({ fieldData: { ' Name ': stored } });
    const result = await service.batchUpdate(profile, 'L', [{ recordId: '1', modId: '7', fieldData: { ' Name ': sent } }], { dryRun: false });
    expect(result).toMatchObject({ successCount: 0, failureCount: 1, skippedChanged: 0 });
    expect(result.failures[0]?.reason).toMatch(/Could not confirm/);
  });
  it('does not reread an uncertain update after cancellation', async () => {
    const { service, editRecord, getRecord } = setup();
    let cancelled = false;
    editRecord.mockRejectedValueOnce(new FMClientError('reply lost', { isRetryable: true }))
      .mockImplementationOnce(async () => {
        cancelled = true;
        throw new FMClientError('stale', { code: '306' });
      });
    getRecord.mockResolvedValue({ fieldData: { ' Name ': 'Ada' } });
    const result = await service.batchUpdate(profile, 'L', [{ recordId: '1', modId: '7', fieldData: { ' Name ': 'Ada' } }], { dryRun: false },
      { log: vi.fn(), reportProgress: vi.fn(), isCancellationRequested: () => cancelled });
    expect(getRecord).not.toHaveBeenCalled();
    expect(editRecord).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ successCount: 0, failureCount: 1, skippedChanged: 0 });
    expect(result.failures[0]?.reason).toMatch(/Could not confirm/);
  });
  it('sends versions and fails stale rows once without stopping later rows, even if marked retryable', async () => {
    const { service, editRecord } = setup();
    editRecord.mockRejectedValueOnce(new FMClientError('stale', { code: '306', isRetryable: true })).mockResolvedValue({});
    const entries = parseBatchUpdateInput('recordId,modId, Name \n1,7,A\n2,8,B', 'csv');
    const result = await service.batchUpdate(profile, ' Layout ', entries, { dryRun: false, concurrency: 1 });
    expect(editRecord).toHaveBeenCalledTimes(2);
    expect(editRecord).toHaveBeenNthCalledWith(1, profile, ' Layout ', '1', { ' Name ': 'A' }, undefined, { modId: '7' });
    expect(editRecord).toHaveBeenNthCalledWith(2, profile, ' Layout ', '2', { ' Name ': 'B' }, undefined, { modId: '8' });
    expect(result).toMatchObject({ successCount: 1, failureCount: 1, skippedChanged: 1,
      failures: [{ recordId: '1', code: '306', reason: 'Changed since the export (someone edited this record). Not updated.' }] });
    expect(result.stoppedReason).toBeUndefined();
  });
  it('omits the version only for the explicit overwrite option', async () => {
    const { service, editRecord } = setup();
    await service.batchUpdate(profile, 'L', parseBatchUpdateInput('recordId,modId,Name\n1,7,A', 'csv'), { dryRun: false, overwriteChanged: true });
    expect(editRecord).toHaveBeenCalledWith(profile, 'L', '1', { Name: 'A' });
  });
  it.each(['csv', 'json'] as const)('warns once per calculated column before writing other %s values; dry run lists the same skipped columns', async (format) => {
    const { service, editRecord, getLayoutMetadata } = setup();
    const row = { recordId: '1', modId: '7', fieldData: { ' Name ': 'A', ' Calc ': 5, Summary: 6, Global: 'session' } };
    const entries = parseBatchUpdateInput(format === 'json' ? JSON.stringify([row]) : 'recordId,modId, Name , Calc ,Summary,Global\n1,7,A,5,6,session', format);
    const log = vi.fn();
    const job = { log, reportProgress: vi.fn(), isCancellationRequested: () => false };
    const dry = await service.batchUpdate(profile, 'L', entries, { dryRun: true }, job);
    expect(editRecord).not.toHaveBeenCalled();
    expect(dry).toMatchObject({ rowsWithModId: 1, rowsChecked: 1, skippedColumns: [' Calc ', 'Summary'] });
    expect(dry.warnings).toEqual([
      'Column " Calc ": calculated by FileMaker; values will be skipped.',
      'Column "Summary": summary field; values will be skipped.'
    ]);
    const result = await service.batchUpdate(profile, 'L', entries, { dryRun: false }, job);
    expect(result.failureCount).toBe(0);
    expect(getLayoutMetadata).toHaveBeenCalledTimes(2); // once per job, including dry run
    expect(editRecord).toHaveBeenCalledWith(profile, 'L', '1', { ' Name ': 'A', Global: 'session' }, undefined, { modId: '7' });
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(editRecord.mock.invocationCallOrder[0]!);
  });
  it('skips a row with only calculated values without sending an empty edit', async () => {
    const { service, editRecord } = setup();
    const result = await service.batchUpdate(profile, 'L', [{ recordId: '1', fieldData: { ' Calc ': 9, Summary: 10 } }], { dryRun: false });
    expect(editRecord).not.toHaveBeenCalled();
    expect(result).toMatchObject({ successCount: 0, failureCount: 0, skippedReadOnlyRows: 1, updatedIds: [], skippedColumns: [' Calc ', 'Summary'] });
  });
  it('reports mixed version coverage and sends unversioned rows without a version', async () => {
    const { service, editRecord } = setup();
    const entries = parseBatchUpdateInput('recordId,modId,Name\n1,0,A\n2,,B', 'csv');
    expect(await service.batchUpdate(profile, 'L', entries, { dryRun: true })).toMatchObject({ rowsWithModId: 1, rowsChecked: 1 });
    expect(await service.batchUpdate(profile, 'L', entries, { dryRun: true, overwriteChanged: true })).toMatchObject({ rowsWithModId: 1, rowsChecked: 0 });
    await service.batchUpdate(profile, 'L', entries, { dryRun: false, concurrency: 1 });
    expect(editRecord).toHaveBeenLastCalledWith(profile, 'L', '2', { Name: 'B' });
  });
  it('round-trips exported collisions unchanged with the reserved version and zero 306s', async () => {
    const { service, editRecord, getLayoutMetadata } = setup();
    const fieldData = { recordId: 'user id', modId: 'user version', ' Name ': ' value ' };
    getLayoutMetadata.mockResolvedValue({ fieldMetaData: Object.keys(fieldData).map((name) => ({ name, result: 'text' })) });
    const client = service as unknown as { fmClient: { findRecords: unknown } };
    client.fmClient.findRecords = vi.fn().mockResolvedValue({ data: [{ recordId: '1', modId: '7', fieldData }] });
    editRecord.mockImplementation(async (_p, _l, _id, values, _control, options) => {
      if (options?.modId !== '7') throw new FMClientError('stale', { code: '306' });
      expect(values).toEqual(fieldData); // no exported value changes, including colliding field names
    });
    const dir = await mkdtemp(join(tmpdir(), 'batch-safety-'));
    try {
      const outputPath = join(dir, 'export.csv');
      await service.batchExportFind(profile, 'L', { query: [{ ' Name ': '*' }] }, { outputPath, format: 'csv', maxRecords: 10 });
      const text = await readFile(outputPath, 'utf8');
      expect(text).toContain('__recordId,__modId');
      const result = await service.batchUpdate(profile, 'L', parseBatchUpdateInput(text, 'csv'), { dryRun: false });
      expect(result).toMatchObject({ failureCount: 0, skippedChanged: 0, successCount: 1 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('round-trips repeating calculated, summary and container columns without writing them', async () => {
    const { service, editRecord, getLayoutMetadata } = setup();
    const fieldData = { ' Name ': 'Ada', ' Calc (1)': 4, ' Calc (2)': 5, 'Summary(1)': 6, 'Summary(2)': 7, 'Photo(1)': 'url', 'Photo(2)': 'url2', 'Qty(1)': 2, 'Qty(2)': 3 };
    getLayoutMetadata.mockResolvedValue({ fieldMetaData: [fields[0],
      { name: ' Calc ', type: ' Calculation ', result: 'number', maxRepeat: 2 },
      { name: 'Summary', type: ' SUMMARY ', result: 'number', maxRepeat: 2 },
      { name: 'Photo', type: ' NORMAL ', result: ' Container ', maxRepeat: 2 },
      { name: 'Qty', type: 'normal', result: ' Number ', maxRepeat: 2 }
    ] });
    (service as unknown as { fmClient: { findRecords: unknown } }).fmClient.findRecords = vi.fn().mockResolvedValue({ data: [{ recordId: '1', modId: '7', fieldData }] });
    const dir = await mkdtemp(join(tmpdir(), 'batch-repeat-'));
    try {
      const outputPath = join(dir, 'export.csv');
      await service.batchExportFind(profile, ' Layout ', { query: [{ ' Name ': '*' }] }, { outputPath, format: 'csv', maxRecords: 10 });
      const entries = parseBatchUpdateInput(await readFile(outputPath, 'utf8'), 'csv');
      const result = await service.batchUpdate(profile, ' Layout ', entries, { dryRun: false });
      expect(result).toMatchObject({ successCount: 1, failureCount: 0, skippedColumns: [' Calc (1)', ' Calc (2)', 'Summary(1)', 'Summary(2)', 'Photo(1)', 'Photo(2)'] });
      expect(editRecord).toHaveBeenCalledWith(profile, ' Layout ', '1', { ' Name ': 'Ada', 'Qty(1)': 2, 'Qty(2)': 3 }, undefined, { modId: '7' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(['matches', 'differs', 'unreadable'])('reconciles 306 after a lost reply when the reread %s', async (outcome) => {
    const { service, editRecord, getRecord } = setup();
    editRecord.mockRejectedValueOnce(new FMClientError('reply lost', { isRetryable: true }))
      .mockRejectedValueOnce(new FMClientError('stale', { code: '306' })).mockResolvedValue({});
    if (outcome === 'unreadable') getRecord.mockRejectedValue(new Error('offline'));
    else getRecord.mockResolvedValue({ recordId: '1', fieldData: { ' Name ': outcome === 'matches' ? 'Ada' : 'Other', Unchanged: 1 } });
    const result = await service.batchUpdate(profile, 'L', [
      { recordId: '1', modId: '7', fieldData: { ' Name ': 'Ada' } },
      { recordId: '2', modId: '8', fieldData: { ' Name ': 'Grace' } }
    ], { dryRun: false, concurrency: 1 });
    expect(editRecord).toHaveBeenCalledTimes(3);
    expect(editRecord.mock.calls.slice(0, 2).map((call) => call[5])).toEqual([{ modId: '7' }, { modId: '7' }]);
    expect(getRecord).toHaveBeenCalledWith(profile, 'L', '1');
    expect(result.skippedChanged).toBe(0);
    if (outcome === 'matches') expect(result).toMatchObject({ successCount: 2, failureCount: 0 });
    else {
      expect(result).toMatchObject({ successCount: 1, failureCount: 1 });
      expect(result.failures[0]?.reason).toMatch(/could not confirm.*first attempt may have succeeded/i);
      expect(result.failures[0]?.reason).not.toContain('someone edited');
    }
  });

  it('keeps a known record-lock retry distinct from an unknown write outcome', async () => {
    const { service, editRecord, getRecord } = setup();
    editRecord.mockRejectedValueOnce(new FMClientError('locked', { code: '301', isRetryable: true }))
      .mockRejectedValueOnce(new FMClientError('stale', { code: '306' }));
    const result = await service.batchUpdate(profile, 'L', [{ recordId: '1', modId: '7', fieldData: { Name: 'Ada' } }], { dryRun: false });
    expect(result.skippedChanged).toBe(1);
    expect(getRecord).not.toHaveBeenCalled();
  });

  it.each([true, false])('detects later duplicate record IDs before writing (dryRun=%s)', async (dryRun) => {
    const { service, editRecord } = setup();
    const log = vi.fn();
    const result = await service.batchUpdate(profile, 'L', [
      { recordId: '1', modId: '7', fieldData: { Name: 'first' } },
      { recordId: '1', modId: '7', fieldData: { Name: 'later' } },
      { recordId: '2', modId: '8', fieldData: { Name: 'other' } }
    ], { dryRun }, { log, reportProgress: vi.fn(), isCancellationRequested: () => false });
    expect(result.failures).toEqual([{ recordId: '1', reason: expect.stringMatching(/duplicate.*skipped/i) }]);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/duplicate/i)]));
    expect(result.skippedChanged ?? 0).toBe(0);
    expect(result.skippedReadOnlyRows ?? 0).toBe(0);
    expect(editRecord).toHaveBeenCalledTimes(dryRun ? 0 : 2);
    if (!dryRun) expect(editRecord.mock.calls.map((call) => call[3])).toEqual([{ Name: 'first' }, { Name: 'other' }]);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/duplicate/i));
  });

});
