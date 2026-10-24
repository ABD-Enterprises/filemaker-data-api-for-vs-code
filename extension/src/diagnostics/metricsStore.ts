import { randomUUID } from 'crypto';

import type * as vscode from 'vscode';

import type {
  RequestMetricsEntry,
  RequestMetricsRecordInput,
  RequestMetricsRecorder,
  RequestHistoryEntry
} from '../types/fm';

const METRICS_KEY = 'filemaker.diagnostics.metrics';

export interface EndpointMetricsSummary {
  endpoint: string;
  operation: string;
  count: number;
  avgDurationMs: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  reauthCount: number;
  cacheHitRatio: number;
}

export interface MetricsSummary {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  avgDurationMs: number;
  totalReauthCount: number;
  cacheHitRatio: number;
  endpoints: EndpointMetricsSummary[];
}

export class MetricsStore implements RequestMetricsRecorder {
  private readonly getMaxEntries: () => number;

  public constructor(
    private readonly workspaceState: vscode.Memento,
    options?: {
      getMaxEntries?: () => number;
    }
  ) {
    this.getMaxEntries = options?.getMaxEntries ?? (() => 200);
  }

  public listEntries(): RequestMetricsEntry[] {
    return this.workspaceState.get<RequestMetricsEntry[]>(METRICS_KEY, []);
  }

  public async clear(): Promise<void> {
    await this.workspaceState.update(METRICS_KEY, []);
  }

  public async record(entry: RequestMetricsRecordInput): Promise<void> {
    const maxEntries = normalizeMaxEntries(this.getMaxEntries());
    const enriched: RequestMetricsEntry = {
      requestId: entry.requestId || randomUUID(),
      timestamp: new Date().toISOString(),
      profileId: entry.profileId,
      operation: entry.operation,
      endpoint: entry.endpoint,
      durationMs: entry.durationMs,
      success: entry.success,
      httpStatus: entry.httpStatus,
      reauthCount: entry.reauthCount ?? 0,
      cacheHit: entry.cacheHit ?? false,
      timedOut: entry.timedOut ?? false
    };

    const existing = this.listEntries();
    const next = [enriched, ...existing].slice(0, maxEntries);
    await this.workspaceState.update(METRICS_KEY, next);
  }

  public getSummary(): MetricsSummary {
    const entries = this.listEntries();
    if (entries.length === 0) {
      return {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        timeoutCount: 0,
        avgDurationMs: 0,
        totalReauthCount: 0,
        cacheHitRatio: 0,
        endpoints: []
      };
    }

    const successCount = entries.filter((entry) => entry.success).length;
    const failureCount = entries.length - successCount;
    const timeoutCount = entries.filter((entry) => entry.timedOut === true).length;
    const avgDurationMs = average(entries.map((entry) => entry.durationMs));
    const totalReauthCount = entries.reduce((sum, entry) => sum + entry.reauthCount, 0);
    const cacheHitRatio = entries.filter((entry) => entry.cacheHit).length / entries.length;

    const endpointGroups = new Map<string, RequestMetricsEntry[]>();
    for (const entry of entries) {
      const key = `${entry.operation}::${entry.endpoint}`;
      const existing = endpointGroups.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        endpointGroups.set(key, [entry]);
      }
    }

    const endpoints: EndpointMetricsSummary[] = Array.from(endpointGroups.values()).map((group) => {
      const sample = group[0];
      if (!sample) {
        return {
          endpoint: 'unknown',
          operation: 'unknown',
          count: 0,
          avgDurationMs: 0,
          successCount: 0,
          failureCount: 0,
          timeoutCount: 0,
          reauthCount: 0,
          cacheHitRatio: 0
        };
      }

      return {
        endpoint: sample.endpoint,
        operation: sample.operation,
        count: group.length,
        avgDurationMs: average(group.map((entry) => entry.durationMs)),
        successCount: group.filter((entry) => entry.success).length,
        failureCount: group.filter((entry) => !entry.success).length,
        timeoutCount: group.filter((entry) => entry.timedOut === true).length,
        reauthCount: group.reduce((sum, entry) => sum + entry.reauthCount, 0),
        cacheHitRatio: group.filter((entry) => entry.cacheHit).length / group.length
      };
    });

    endpoints.sort((left, right) => right.count - left.count || left.endpoint.localeCompare(right.endpoint));

    return {
      totalRequests: entries.length,
      successCount,
      failureCount,
      timeoutCount,
      avgDurationMs,
      totalReauthCount,
      cacheHitRatio,
      endpoints
    };
  }

  public toHistoryLikeEntries(limit = 30): RequestHistoryEntry[] {
    return this.listEntries()
      .slice(0, limit)
      .map((entry) => ({
        id: entry.requestId,
        requestId: entry.requestId,
        timestamp: entry.timestamp,
        profileId: entry.profileId,
        operation: entry.operation,
        durationMs: entry.durationMs,
        success: entry.success,
        httpStatus: entry.httpStatus,
        message: entry.endpoint
      }));
  }
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function normalizeMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return 200;
  }

  return Math.min(1000, value);
}
