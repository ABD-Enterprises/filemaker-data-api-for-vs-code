import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchService, inferExportFormat, parseBatchUpdateInput } from '../../../src/services/batchService';
import { FMClientError } from '../../../src/services/errors';
import type { FMClient } from '../../../src/services/fmClient';
import type {
  BatchUpdateEntry,
  ConnectionProfile,
  FileMakerRecord,
  FindRecordsResult
} from '../../../src/types/fm';

function profile(): ConnectionProfile {
  return {
    id: 'p1',
    name: 'Dev',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest',
    username: 'user'
  };
}

function record(id: string, fieldData: Record<string, unknown>): FileMakerRecord {
  return {
    recordId: id,
    modId: '1',
    fieldData
  };
}

function findResult(records: FileMakerRecord[]): FindRecordsResult {
  return {
    data: records,
    dataInfo: { foundCount: records.length, returnedCount: records.length }
  };
}

function createFmClient(overrides: Partial<FMClient> = {}): FMClient {
  const stub: Partial<FMClient> = {
    findRecords: vi.fn(),
    editRecord: vi.fn(),
    ...overrides
  };
  return stub as FMClient;
}

describe('BatchService.batchExportFind', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'batch-export-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams CSV to disk and reports exportedRecords on happy path', async () => {
    const findRecords = vi
      .fn()
      .mockResolvedValueOnce(findResult([record('1', { name: 'A' }), record('2', { name: 'B' })]))
      .mockResolvedValueOnce(findResult([])); // pagination end
    const fmClient = createFmClient({ findRecords } as never);
    const service = new BatchService(fmClient, {
      getPerformanceMode: () => 'standard'
    });

    const outputPath = join(dir, 'export.csv');
    const result = await service.batchExportFind(
      profile(),
      'Contacts',
      { query: [{}] },
      { outputPath, format: 'csv', pageSize: 2, maxRecords: 100 }
    );

    expect(result.exportedRecords).toBe(2);
    expect(result.format).toBe('csv');
    expect(result.truncated).toBe(false);
    const text = await readFile(outputPath, 'utf8');
    expect(text).toContain('recordId,modId,name');
    expect(text).toContain('1,1,A');
    expect(text).toContain('2,1,B');
  });

  it('truncates at maxRecords when more pages would be available', async () => {
    const findRecords = vi
      .fn()
      .mockResolvedValueOnce(findResult([record('1', { x: 1 }), record('2', { x: 2 })]))
      .mockResolvedValueOnce(findResult([record('3', { x: 3 })]))
      .mockResolvedValueOnce(findResult([record('4', { x: 4 })])); // the probe: another record exists
    const fmClient = createFmClient({ findRecords } as never);
    const service = new BatchService(fmClient, { getPerformanceMode: () => 'standard' });

    const outputPath = join(dir, 'truncated.csv');
    const result = await service.batchExportFind(
      profile(),
      'Contacts',
      { query: [{}] },
      { outputPath, format: 'csv', pageSize: 2, maxRecords: 3 }
    );

    expect(result.exportedRecords).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated when the found set has exactly maxRecords rows', async () => {
    const findRecords = vi
      .fn()
      .mockResolvedValueOnce(findResult([record('1', { x: 1 }), record('2', { x: 2 })]))
      .mockResolvedValueOnce(findResult([])); // nothing after the cap
    const service = new BatchService(createFmClient({ findRecords } as never), { getPerformanceMode: () => 'standard' });

    const result = await service.batchExportFind(
      profile(),
      'Contacts',
      { query: [{}] },
      { outputPath: join(dir, 'exact.csv'), format: 'csv', pageSize: 2, maxRecords: 2 }
    );

    expect(result.exportedRecords).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('stops cleanly when a page returns an empty result', async () => {
    const findRecords = vi.fn().mockResolvedValueOnce(findResult([]));
    const fmClient = createFmClient({ findRecords } as never);
    const service = new BatchService(fmClient);

    const outputPath = join(dir, 'empty.csv');
    const result = await service.batchExportFind(
      profile(),
      'Contacts',
      { query: [{}] },
      { outputPath, format: 'csv', pageSize: 10, maxRecords: 100 }
    );

    expect(result.exportedRecords).toBe(0);
    expect(result.truncated).toBe(false);
    expect(findRecords).toHaveBeenCalledTimes(1);
  });

  it('forces JSONL output in high-scale performance mode regardless of requested format', async () => {
    const findRecords = vi
      .fn()
      .mockResolvedValueOnce(findResult([record('1', { x: 1 })]))
      .mockResolvedValueOnce(findResult([]));
    const fmClient = createFmClient({ findRecords } as never);
    const service = new BatchService(fmClient, {
      getPerformanceMode: () => 'high-scale'
    });

    const outputPath = join(dir, 'forced.jsonl');
    const result = await service.batchExportFind(
      profile(),
      'Contacts',
      { query: [{}] },
      { outputPath, format: 'csv', pageSize: 1, maxRecords: 100 }
    );

    expect(result.format).toBe('jsonl');
  });
});

describe('BatchService.batchUpdate', () => {
  it('returns a dry-run summary without touching the API when dryRun is true', async () => {
    const editRecord = vi.fn();
    const fmClient = createFmClient({ editRecord } as never);
    const service = new BatchService(fmClient, {
      getDryRunDefault: () => true,
      getPerformanceMode: () => 'standard'
    });

    const entries: BatchUpdateEntry[] = [
      { recordId: '1', fieldData: { x: 1 } },
      { recordId: '2', fieldData: { x: 2 } }
    ];
    const result = await service.batchUpdate(profile(), 'Contacts', entries);

    expect(result).toEqual({
      dryRun: true,
      total: 2,
      attempted: 0,
      successCount: 0,
      failureCount: 0,
      failures: []
    });
    expect(editRecord).not.toHaveBeenCalled();
  });

  it('records partial failures with reasons', async () => {
    const editRecord = vi
      .fn()
      .mockResolvedValueOnce({ recordId: '1', modId: '2' })
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockResolvedValueOnce({ recordId: '3', modId: '2' });
    const fmClient = createFmClient({ editRecord } as never);
    const service = new BatchService(fmClient, {
      getDryRunDefault: () => false,
      getConcurrency: () => 1,
      getPerformanceMode: () => 'standard'
    });

    const entries: BatchUpdateEntry[] = [
      { recordId: '1', fieldData: { a: 1 } },
      { recordId: '2', fieldData: { a: 2 } },
      { recordId: '3', fieldData: { a: 3 } }
    ];
    const result = await service.batchUpdate(profile(), 'Contacts', entries, { dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.failures[0]?.recordId).toBe('2');
    expect(result.failures[0]?.reason).toContain('forbidden');
  });

  it('respects the configured concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const editRecord = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { recordId: '1', modId: '2' };
    });
    const fmClient = createFmClient({ editRecord } as never);
    const service = new BatchService(fmClient, {
      getDryRunDefault: () => false,
      getConcurrency: () => 2,
      getPerformanceMode: () => 'standard'
    });

    const entries: BatchUpdateEntry[] = Array.from({ length: 8 }, (_, i) => ({
      recordId: String(i + 1),
      fieldData: { i }
    }));
    await service.batchUpdate(profile(), 'Contacts', entries, { dryRun: false, concurrency: 2 });

    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('inferExportFormat', () => {
  it('returns csv for .csv paths', () => {
    expect(inferExportFormat('out.csv')).toBe('csv');
    expect(inferExportFormat('/tmp/dir/out.CSV')).toBe('csv');
  });

  it('returns jsonl for unknown / .jsonl extensions', () => {
    expect(inferExportFormat('out.jsonl')).toBe('jsonl');
    expect(inferExportFormat('out.txt')).toBe('jsonl');
    expect(inferExportFormat('out')).toBe('jsonl');
  });
});

describe('parseBatchUpdateInput', () => {
  it('parses JSON array of {recordId, fieldData}', () => {
    const input = JSON.stringify([
      { recordId: '1', fieldData: { a: 1 } },
      { recordId: '2', fieldData: { a: 2 } }
    ]);
    const entries = parseBatchUpdateInput(input, 'json');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.recordId).toBe('1');
  });

  it('rejects JSON that is not an array', () => {
    expect(() => parseBatchUpdateInput('{}', 'json')).toThrow();
  });

  it('parses CSV with a recordId column', () => {
    const csv = 'recordId,name,age\n1,Alice,30\n2,Bob,25\n';
    const entries = parseBatchUpdateInput(csv, 'csv');
    expect(entries).toHaveLength(2);
    // parseBatchUpdateInput coerces numeric strings to numbers
    expect(entries[0]).toEqual({ recordId: '1', fieldData: { name: 'Alice', age: 30 } });
  });
});

describe('batch export then import round trip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'batch-roundtrip-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function exportRecords(records: FileMakerRecord[]): Promise<string> {
    const findRecords = vi.fn().mockResolvedValueOnce(findResult(records)).mockResolvedValueOnce(findResult([]));
    const service = new BatchService(createFmClient({ findRecords } as never), {
      getPerformanceMode: () => 'standard'
    });
    const outputPath = join(dir, 'export.csv');
    await service.batchExportFind(profile(), 'Contacts', { query: [{}] }, { outputPath, format: 'csv', pageSize: 10, maxRecords: 100 });
    return readFile(outputPath, 'utf8');
  }

  it('re-imports what the real writer exported, without sending recordId or modId as fields', async () => {
    const records = [
      record('1', {
        name: 'Alice, "Al" Smith',
        note: 'line one\nline two',
        age: 30,
        active: true,
        tags: ['a', 'b'],
        formula: '=HYPERLINK("http://example.com")',
        cmd: '@SUM(1)',
        tab: '\tindented',
        negative: -5
      }),
      record('2', { name: 'Bob', age: 25 })
    ];

    const csv = await exportRecords(records);
    const entries = parseBatchUpdateInput(csv, 'csv');

    expect(entries.map((entry) => entry.recordId)).toEqual(['1', '2']);
    for (const [index, entry] of entries.entries()) {
      expect(Object.keys(entry.fieldData)).not.toContain('modId');
      expect(Object.keys(entry.fieldData)).not.toContain('recordId');
      expect(entry.fieldData).toEqual(records[index]?.fieldData);
    }
  });

  it('ignores only the exact recordId and modId meta columns (whitespace and a BOM are allowed)', () => {
    const entries = parseBatchUpdateInput('\uFEFFrecordId, modId ,name\n7,3,Zed\n', 'csv');
    expect(entries).toEqual([{ recordId: '7', fieldData: { name: 'Zed' } }]);
  });

  it('does not take a field named RecordID for the record id', () => {
    expect(() => parseBatchUpdateInput('RecordID,Name\n7,Alice\n', 'csv')).toThrow(/must include a "recordId" column/);
    expect(() => parseBatchUpdateInput('recordid,Name\n7,Alice\n', 'csv')).toThrow(/recordId/);
  });

  it('writes user fields named RecordID and ModId as fields when a real recordId column exists', () => {
    const entries = parseBatchUpdateInput('recordId,RecordID,ModId,Name\n7,99,5,Alice\n', 'csv');
    expect(entries).toEqual([{ recordId: '7', fieldData: { RecordID: 99, ModId: 5, Name: 'Alice' } }]);
  });

  it('documents the lossy cases: cells that look like JSON or numbers become JSON values, empty cells are skipped', async () => {
    const csv = await exportRecords([record('1', { code: '12', flag: 'true', blank: '', text: 'plain' })]);
    expect(parseBatchUpdateInput(csv, 'csv')).toEqual([
      { recordId: '1', fieldData: { code: 12, flag: true, text: 'plain' } }
    ]);
  });
});

describe('BatchService.batchUpdate failure handling', () => {
  const run = async (editRecord: ReturnType<typeof vi.fn>, entries = 6, extra?: ConstructorParameters<typeof BatchService>[1]) => {
    const service = new BatchService(createFmClient({ editRecord } as never), {
      getDryRunDefault: () => false,
      getConcurrency: () => 1,
      getPerformanceMode: () => 'standard',
      ...extra
    });
    const list: BatchUpdateEntry[] = Array.from({ length: entries }, (_, i) => ({ recordId: String(i + 1), fieldData: { a: i } }));
    return service.batchUpdate(profile(), 'Contacts', list, { dryRun: false, concurrency: 1 });
  };

  const businessError = (code: string, extra: Record<string, unknown> = {}) =>
    new FMClientError(`FileMaker API error (HTTP 500) [${code}]: x`, { status: 500, code, isRetryable: false, ...extra });

  it('does not retry a FileMaker business error that arrives as HTTP 500, and does not open the breaker', async () => {
    const editRecord = vi.fn().mockRejectedValue(businessError('509', { fmCategory: 'request' }));
    const result = await run(editRecord, 8);
    expect(editRecord).toHaveBeenCalledTimes(8); // one attempt per record, no retries
    expect(result.failureCount).toBe(8);
    expect(result.attempted).toBe(8); // the breaker never stopped the job
  });

  it('retries a transient failure with no FileMaker code, and a record-in-use answer (301)', async () => {
    const editRecord = vi
      .fn()
      .mockRejectedValueOnce(new FMClientError('Bad gateway', { status: 502, isRetryable: true }))
      .mockRejectedValueOnce(businessError('301', { isRetryable: true, fmCategory: 'conflict' }))
      .mockResolvedValue({ recordId: '1', modId: '2' });
    const result = await run(editRecord, 1);
    expect(editRecord).toHaveBeenCalledTimes(3);
    expect(result.successCount).toBe(1);
  });

  it('honours Retry-After on a 429', async () => {
    vi.useFakeTimers();
    try {
      const editRecord = vi
        .fn()
        .mockRejectedValueOnce(new FMClientError('Too many requests', { status: 429, isRetryable: true, retryAfterMs: 5_000 }))
        .mockResolvedValue({ recordId: '1', modId: '2' });
      const pending = run(editRecord, 1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(editRecord).toHaveBeenCalledTimes(1); // still waiting for the 5 s the server asked for
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(editRecord).toHaveBeenCalledTimes(2);
      expect(result.successCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the whole job once, with the reason, when the account lacks the privilege', async () => {
    const editRecord = vi.fn().mockRejectedValue(
      businessError('200', { fmCategory: 'privilege', message: undefined })
    );
    const result = await run(editRecord, 20);
    expect(editRecord).toHaveBeenCalledTimes(1);
    expect(result.stoppedReason).toMatch(/\[200\]/);
    expect(result.notAttempted).toBe(19);
    expect(result.failureCount).toBe(1);
  });
});
