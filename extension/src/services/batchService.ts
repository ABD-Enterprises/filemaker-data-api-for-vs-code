import { extname } from 'path';

import type { FMClient } from './fmClient';
import { FMClientError } from './errors';
import { AdaptiveConcurrency } from '../performance/adaptiveConcurrency';
import { CircuitBreaker } from '../performance/circuitBreaker';
import type { CircuitBreakerRegistry } from '../performance/circuitBreakerRegistry';
import type {
  BatchExportFormat,
  BatchExportOptions,
  BatchExportResult,
  BatchUpdateEntry,
  BatchUpdateOptions,
  BatchUpdateResult,
  ConnectionProfile,
  FindRecordsRequest,
  JobContext,
  PerformanceMode
} from '../types/fm';
import { createCsvStreamWriter } from '../utils/csvStreamWriter';
import { createJsonlWriter } from '../utils/jsonlWriter';

interface BatchServiceOptions {
  getMaxRecords?: () => number;
  getConcurrency?: () => number;
  getDryRunDefault?: () => boolean;
  getPerformanceMode?: () => PerformanceMode;
  circuitBreakerRegistry?: CircuitBreakerRegistry;
}

export class BatchService {
  private readonly getMaxRecords: () => number;
  private readonly getConcurrency: () => number;
  private readonly getDryRunDefault: () => boolean;
  private readonly getPerformanceMode: () => PerformanceMode;
  private readonly circuitBreakerRegistry?: CircuitBreakerRegistry;

  public constructor(private readonly fmClient: FMClient, options?: BatchServiceOptions) {
    this.getMaxRecords = options?.getMaxRecords ?? (() => 10_000);
    this.getConcurrency = options?.getConcurrency ?? (() => 4);
    this.getDryRunDefault = options?.getDryRunDefault ?? (() => true);
    this.getPerformanceMode = options?.getPerformanceMode ?? (() => 'standard');
    this.circuitBreakerRegistry = options?.circuitBreakerRegistry;
  }

  public getDefaultBatchUpdateOptions(): BatchUpdateOptions {
    return {
      dryRun: this.getDryRunDefault(),
      concurrency: clampConcurrency(this.getConcurrency())
    };
  }

  public async batchExportFind(
    profile: ConnectionProfile,
    layout: string,
    request: FindRecordsRequest,
    options: BatchExportOptions,
    job?: JobContext
  ): Promise<BatchExportResult> {
    const maxRecords = normalizeMaxRecords(options.maxRecords || this.getMaxRecords());
    const performanceMode = this.getPerformanceMode();
    const pageSize = normalizePageSize(options.pageSize, performanceMode);
    const format: BatchExportFormat = performanceMode === 'high-scale' ? 'jsonl' : options.format;

    let exported = 0;
    let offset = typeof request.offset === 'number' ? request.offset : 1;
    let truncated = false;
    const jsonlWriter = format === 'jsonl' ? await createJsonlWriter(options.outputPath) : undefined;
    const csvWriter = format === 'csv' ? await createCsvStreamWriter(options.outputPath) : undefined;

    try {
      while (exported < maxRecords) {
        if (job?.isCancellationRequested()) {
          job.log('warn', 'Batch export cancelled by user.');
          break;
        }

        const remaining = maxRecords - exported;
        const limit = Math.min(pageSize, remaining);
        const page = await this.fmClient.findRecords(profile, layout, {
          ...request,
          limit,
          offset
        });

        if (!page.data || page.data.length === 0) {
          break;
        }

        for (const record of page.data) {
          if (format === 'jsonl') {
            await jsonlWriter?.append(record);
          } else {
            await csvWriter?.append({
              recordId: record.recordId,
              modId: record.modId,
              ...record.fieldData
            });
          }
        }

        exported += page.data.length;
        offset += page.data.length;

        if (job) {
          job.reportProgress(Math.round((exported / maxRecords) * 100), `Exported ${exported} records.`);
        }

        if (page.data.length < limit) {
          break;
        }
      }

      if (exported >= maxRecords) {
        truncated = true;
      }

      return {
        outputPath: options.outputPath,
        format,
        exportedRecords: exported,
        truncated
      };
    } finally {
      await jsonlWriter?.close();
      await csvWriter?.close();
    }
  }

  public async batchUpdate(
    profile: ConnectionProfile,
    layout: string,
    entries: BatchUpdateEntry[],
    options?: Partial<BatchUpdateOptions>,
    job?: JobContext
  ): Promise<BatchUpdateResult> {
    const dryRun = options?.dryRun ?? this.getDryRunDefault();
    const configuredConcurrency = clampConcurrency(options?.concurrency ?? this.getConcurrency());
    const performanceMode = this.getPerformanceMode();
    const maxConcurrency = performanceMode === 'high-scale' ? Math.max(2, configuredConcurrency) : configuredConcurrency;
    const total = entries.length;

    if (dryRun) {
      return {
        dryRun: true,
        total,
        attempted: 0,
        successCount: 0,
        failureCount: 0,
        failures: []
      };
    }

    const queue = [...entries];
    let completed = 0;
    let successCount = 0;
    const failures: BatchUpdateResult['failures'] = [];
    const adaptive = new AdaptiveConcurrency({
      initial: configuredConcurrency,
      min: 1,
      max: maxConcurrency,
      targetLatencyMs: performanceMode === 'high-scale' ? 1400 : 900
    });
    const registry = this.circuitBreakerRegistry;
    const breakerName = `batchUpdate:${profile.id}:${layout}`;
    const breaker = new CircuitBreaker({
      failureThreshold: performanceMode === 'high-scale' ? 6 : 4,
      openMs: performanceMode === 'high-scale' ? 6_000 : 4_000,
      onTransition: registry
        ? (transition) => registry.recordTransition(breakerName, transition)
        : undefined
    });
    if (registry) {
      registry.register(breakerName, breaker);
    }

    const inFlight = new Set<Promise<void>>();

    const scheduleNext = (): void => {
      while (queue.length > 0 && inFlight.size < adaptive.getLimit()) {
        if (!breaker.canRequest()) {
          return;
        }

        const next = queue.shift();
        if (!next) {
          return;
        }

        const updatePromise = this.updateOneWithRetry(profile, layout, next, adaptive, breaker)
          .then(() => {
            successCount += 1;
          })
          .catch((error) => {
            failures.push({
              recordId: next.recordId,
              reason: error instanceof Error ? error.message : 'Unknown update failure'
            });
          })
          .finally(() => {
            completed += 1;
            if (job) {
              job.reportProgress(Math.round((completed / total) * 100), `Updated ${completed}/${total}`);
            }
          });

        const tracked = updatePromise.finally(() => {
          inFlight.delete(tracked);
        });
        inFlight.add(tracked);
      }
    };

    while (queue.length > 0 || inFlight.size > 0) {
      if (job?.isCancellationRequested()) {
        break;
      }

      scheduleNext();

      if (inFlight.size === 0) {
        if (!breaker.canRequest()) {
          await sleep(300);
          continue;
        }
        break;
      }

      await Promise.race(inFlight);
    }

    if (registry) {
      registry.unregister(breakerName);
    }

    return {
      dryRun: false,
      total,
      attempted: completed,
      successCount,
      failureCount: failures.length,
      failures
    };
  }

  private async updateOneWithRetry(
    profile: ConnectionProfile,
    layout: string,
    entry: BatchUpdateEntry,
    adaptive: AdaptiveConcurrency,
    breaker: CircuitBreaker
  ): Promise<void> {
    let attempt = 0;

    while (attempt < 3) {
      const startedAt = Date.now();
      try {
        await this.fmClient.editRecord(profile, layout, entry.recordId, entry.fieldData);
        adaptive.recordSuccess(Date.now() - startedAt);
        breaker.recordSuccess();
        return;
      } catch (error) {
        const status = getStatusFromError(error);
        adaptive.recordFailure(status);
        breaker.recordFailure();

        const retryable = status === 429 || (typeof status === 'number' && status >= 500);
        if (!retryable || attempt >= 2) {
          throw error;
        }

        await sleep(adaptive.getBackoffDelayMs(attempt, status));
        attempt += 1;
      }
    }
  }
}

export function inferExportFormat(outputPath: string): BatchExportFormat {
  const extension = extname(outputPath).toLowerCase();
  if (extension === '.csv') {
    return 'csv';
  }

  return 'jsonl';
}

export function parseBatchUpdateInput(content: string, format: 'json' | 'csv'): BatchUpdateEntry[] {
  if (format === 'json') {
    const parsed = JSON.parse(content) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error('Batch update JSON must be an array.');
    }

    return parsed.map((entry) => normalizeBatchUpdateEntry(entry));
  }

  return parseCsvBatchUpdates(content);
}

function parseCsvBatchUpdates(content: string): BatchUpdateEntry[] {
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0];
  if (!headers) {
    return [];
  }
  const recordIdIndex = headers.findIndex((header) => header === 'recordId');
  if (recordIdIndex < 0) {
    throw new Error('CSV must include a "recordId" column.');
  }

  const entries: BatchUpdateEntry[] = [];

  for (const row of rows.slice(1)) {
    const recordId = row[recordIdIndex]?.trim();
    if (!recordId) {
      continue;
    }

    const fieldData: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      if (header === 'recordId') {
        return;
      }

      const value = row[index];
      if (value === undefined || value === '') {
        return;
      }

      fieldData[header] = parsePossibleJsonValue(value);
    });

    entries.push({
      recordId,
      fieldData
    });
  }

  return entries;
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentValue += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }

      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = '';
      continue;
    }

    currentValue += char;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows.filter((row) => row.some((cell) => cell.trim().length > 0));
}

function parsePossibleJsonValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }

  return raw;
}

function normalizeBatchUpdateEntry(input: unknown): BatchUpdateEntry {
  if (!input || typeof input !== 'object') {
    throw new Error('Batch update entries must be objects.');
  }

  const record = input as Record<string, unknown>;
  const recordId = record.recordId;
  if (typeof recordId !== 'string' || recordId.trim().length === 0) {
    throw new Error('Batch update entries must include a recordId string.');
  }

  const fieldData = record.fieldData;
  if (!fieldData || typeof fieldData !== 'object' || Array.isArray(fieldData)) {
    throw new Error('Batch update entries must include a fieldData object.');
  }

  return {
    recordId,
    fieldData: fieldData as Record<string, unknown>
  };
}

function normalizeMaxRecords(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return 10_000;
  }

  return Math.min(value, 250_000);
}

function normalizePageSize(value: number | undefined, performanceMode: PerformanceMode): number {
  if (!value || !Number.isInteger(value) || value <= 0) {
    return performanceMode === 'high-scale' ? 400 : 100;
  }

  return Math.min(value, performanceMode === 'high-scale' ? 1000 : 500);
}

function clampConcurrency(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return 4;
  }

  return Math.max(1, Math.min(value, 10));
}

function getStatusFromError(error: unknown): number | undefined {
  if (error instanceof FMClientError) {
    return error.status;
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
