import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchService, inferExportFormat, parseBatchUpdateInput } from '../../../src/services/batchService';
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
      .mockResolvedValueOnce(findResult([record('3', { x: 3 })]));
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
    expect(entries[0].recordId).toBe('1');
  });

  it('rejects JSON that is not an array', () => {
    expect(() => parseBatchUpdateInput('{}', 'json')).toThrow();
  });

  it('parses CSV with a recordId column', () => {
    const csv = 'recordId,name,age\n1,Alice,30\n2,Bob,25\n';
    const entries = parseBatchUpdateInput(csv, 'csv');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ recordId: '1', fieldData: { name: 'Alice', age: '30' } });
  });
});
