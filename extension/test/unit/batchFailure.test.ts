import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { BatchService } from '../../src/services/batchService';
import type { FMClient } from '../../src/services/fmClient';

/**
 * The actual FMClient.findRecords returns a FindRecordsResult directly:
 *   { data: FileMakerRecord[], dataInfo?: Record<string, unknown> }
 *
 * The method under test is batchExportFind(profile, layout, request, options, job?).
 * BatchExportOptions requires: format, maxRecords, outputPath.
 * BatchExportResult has: outputPath, format, exportedRecords, truncated.
 *
 * The service does NOT catch errors from findRecords during pagination -- errors
 * propagate up. So a mid-pagination failure throws rather than returning partial results.
 */

function makeProfile() {
  return {
    id: 'test',
    name: 'Test Profile',
    serverUrl: 'https://example.com',
    database: 'TestDB',
    authMode: 'direct' as const
  };
}

describe('batch service failure scenarios', () => {
  it('should throw when pagination fails mid-way, after exporting first page', async () => {
    let callCount = 0;
    const mockClient = {
      findRecords: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            data: Array.from({ length: 100 }, (_, i) => ({
              fieldData: { Name: `Record ${i}` },
              recordId: String(i),
              modId: '1'
            })),
            dataInfo: { foundCount: 250, returnedCount: 100, totalRecordCount: 250 }
          };
        }
        throw new Error('Connection lost');
      })
    } as unknown as FMClient;

    const outputPath = join(tmpdir(), `fm-export-${randomUUID()}.jsonl`);
    const service = new BatchService(mockClient, {
      getMaxRecords: () => 10000,
      getConcurrency: () => 4,
      getDryRunDefault: () => false,
      getPerformanceMode: () => 'standard'
    });

    const profile = makeProfile();

    await expect(
      service.batchExportFind(
        profile,
        'Contacts',
        { query: [{ Name: '*' }] },
        { format: 'jsonl', maxRecords: 10000, outputPath }
      )
    ).rejects.toThrow('Connection lost');

    // Verify the first page was fetched before the failure
    expect(mockClient.findRecords).toHaveBeenCalledTimes(2);
  });

  it('should throw on empty result set when server returns an error', async () => {
    const mockClient = {
      findRecords: vi.fn(async () => {
        const error = Object.assign(new Error('No records match the request'), {
          isAxiosError: true,
          response: {
            status: 401,
            data: { messages: [{ code: '401', message: 'No records match the request' }] }
          }
        });
        throw error;
      })
    } as unknown as FMClient;

    const outputPath = join(tmpdir(), `fm-export-${randomUUID()}.jsonl`);
    const service = new BatchService(mockClient, {
      getMaxRecords: () => 10000,
      getConcurrency: () => 4,
      getDryRunDefault: () => false,
      getPerformanceMode: () => 'standard'
    });

    const profile = makeProfile();

    await expect(
      service.batchExportFind(
        profile,
        'Contacts',
        { query: [{ Name: 'nonexistent' }] },
        { format: 'jsonl', maxRecords: 10000, outputPath }
      )
    ).rejects.toThrow('No records match the request');
  });

  it('should return zero exported records when the first page is empty', async () => {
    const mockClient = {
      findRecords: vi.fn(async () => ({
        data: [],
        dataInfo: { foundCount: 0, returnedCount: 0, totalRecordCount: 0 }
      }))
    } as unknown as FMClient;

    const outputPath = join(tmpdir(), `fm-export-${randomUUID()}.jsonl`);
    const service = new BatchService(mockClient, {
      getMaxRecords: () => 10000,
      getConcurrency: () => 4,
      getDryRunDefault: () => false,
      getPerformanceMode: () => 'standard'
    });

    const profile = makeProfile();

    const result = await service.batchExportFind(
      profile,
      'Contacts',
      { query: [{ Name: '*' }] },
      { format: 'jsonl', maxRecords: 10000, outputPath }
    );

    expect(result.exportedRecords).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('should stop at maxRecords and set truncated to true', async () => {
    const mockClient = {
      findRecords: vi.fn(async () => ({
        data: Array.from({ length: 100 }, (_, i) => ({
          fieldData: { Name: `Record ${i}` },
          recordId: String(i),
          modId: '1'
        })),
        dataInfo: { foundCount: 500, returnedCount: 100, totalRecordCount: 500 }
      }))
    } as unknown as FMClient;

    const outputPath = join(tmpdir(), `fm-export-${randomUUID()}.jsonl`);
    const service = new BatchService(mockClient, {
      getMaxRecords: () => 200,
      getConcurrency: () => 4,
      getDryRunDefault: () => false,
      getPerformanceMode: () => 'standard'
    });

    const profile = makeProfile();

    const result = await service.batchExportFind(
      profile,
      'Contacts',
      { query: [{ Name: '*' }] },
      { format: 'jsonl', maxRecords: 200, outputPath }
    );

    expect(result.exportedRecords).toBe(200);
    expect(result.truncated).toBe(true);
  });

  it('should respect job cancellation', async () => {
    let callCount = 0;
    const mockClient = {
      findRecords: vi.fn(async () => {
        callCount++;
        return {
          data: Array.from({ length: 100 }, (_, i) => ({
            fieldData: { Name: `Record ${i}` },
            recordId: String(i),
            modId: '1'
          })),
          dataInfo: { foundCount: 1000, returnedCount: 100, totalRecordCount: 1000 }
        };
      })
    } as unknown as FMClient;

    const outputPath = join(tmpdir(), `fm-export-${randomUUID()}.jsonl`);
    const service = new BatchService(mockClient, {
      getMaxRecords: () => 10000,
      getConcurrency: () => 4,
      getDryRunDefault: () => false,
      getPerformanceMode: () => 'standard'
    });

    const profile = makeProfile();

    // Cancel after the first page is fetched
    let cancelled = false;
    const job = {
      reportProgress: vi.fn(),
      log: vi.fn(),
      isCancellationRequested: () => {
        if (callCount >= 1) {
          cancelled = true;
        }
        return cancelled;
      }
    };

    const result = await service.batchExportFind(
      profile,
      'Contacts',
      { query: [{ Name: '*' }] },
      { format: 'jsonl', maxRecords: 10000, outputPath },
      job
    );

    // Should have exported the first page then stopped
    expect(result.exportedRecords).toBe(100);
    expect(job.log).toHaveBeenCalledWith('warn', 'Batch export cancelled by user.');
  });
});
