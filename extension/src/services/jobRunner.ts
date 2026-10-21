import { randomUUID } from 'crypto';

import type * as vscode from 'vscode';

import type { JobContext, JobLogEntry, JobRuntimeState, JobSummary } from '../types/fm';
import { redactString } from '../utils/redact';

const JOBS_RECENT_KEY = 'filemaker.jobs.recent';
const DEFAULT_RECENT_LIMIT = 25;

export interface JobHandle<T = unknown> {
  id: string;
  cancel: () => void;
  getState: () => JobRuntimeState<T>;
}

type JobTask<T> = (context: JobContext) => Promise<T>;
type JobListener = (job: JobRuntimeState) => void;

export class JobRunner {
  private readonly activeJobs = new Map<string, JobRuntimeState>();
  private readonly jobControllers = new Map<string, { cancelled: boolean }>();
  private readonly listeners = new Set<JobListener>();
  private readonly getRecentLimit: () => number;

  public constructor(
    private readonly workspaceState: vscode.Memento,
    options?: {
      getRecentLimit?: () => number;
    }
  ) {
    this.getRecentLimit = options?.getRecentLimit ?? (() => DEFAULT_RECENT_LIMIT);
  }

  public startJob<T>(name: string, task: JobTask<T>): JobHandle<T> {
    const id = randomUUID();
    const state: JobRuntimeState<T> = {
      id,
      name,
      startedAt: new Date().toISOString(),
      status: 'queued',
      progress: 0,
      logs: []
    };
    const controller = { cancelled: false };

    this.activeJobs.set(id, state);
    this.jobControllers.set(id, controller);
    this.emit(state);

    void this.runTask(state, controller, task);

    return {
      id,
      cancel: () => { this.cancelJob(id); },
      getState: () => ({ ...state, logs: [...state.logs] })
    };
  }

  public cancelJob(id: string): boolean {
    const controller = this.jobControllers.get(id);
    const state = this.activeJobs.get(id);
    if (!controller || !state || !['queued', 'running'].includes(state.status)) return false;
    controller.cancelled = true;
    state.status = 'cancelled';
    state.details = 'Cancelling; waiting for requests already sent to finish.';
    this.emit(state);
    return true;
  }

  public listJobs(): JobRuntimeState[] {
    return Array.from(this.activeJobs.values())
      .map((job) => ({ ...job, logs: [...job.logs] }))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public getRecentSummaries(): JobSummary[] {
    return this.workspaceState.get<JobSummary[]>(JOBS_RECENT_KEY, []);
  }

  public onDidChange(listener: JobListener): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener)
    };
  }

  private async runTask<T>(
    state: JobRuntimeState<T>,
    controller: { cancelled: boolean },
    task: JobTask<T>
  ): Promise<void> {
    state.status = 'running';
    this.emit(state);

    const context: JobContext = {
      reportProgress: (percent, details) => {
        state.progress = clampProgress(percent);
        if (details) {
          state.details = sanitizeLogMessage(details);
        }
        this.emit(state);
      },
      log: (level, message) => {
        const entry: JobLogEntry = {
          timestamp: new Date().toISOString(),
          level,
          message: sanitizeLogMessage(message)
        };
        state.logs.push(entry);
        this.emit(state);
      },
      isCancellationRequested: () => controller.cancelled
    };

    try {
      const result = await task(context);

      state.result = result;
      if (controller.cancelled) {
        state.status = 'cancelled';
      } else {
        state.status = 'completed';
        state.progress = 100;
        const counts = batchCounts(result);
        if (counts) {
          state.details = `${counts.successCount} succeeded, ${counts.failureCount} failed`;
          if (counts.failureCount > 0) state.status = `completed with ${counts.failureCount} failed row${counts.failureCount === 1 ? '' : 's'}`;
        }
      }
    } catch (error) {
      if (controller.cancelled) {
        state.status = 'cancelled';
      } else {
        state.status = 'failed';
        state.details = error instanceof Error ? sanitizeLogMessage(error.message) : 'Job failed.';
      }
    } finally {
      state.finishedAt = new Date().toISOString();
      this.emit(state);
      await this.persistSummary(state);
      this.jobControllers.delete(state.id);
    }
  }

  private async persistSummary(state: JobRuntimeState): Promise<void> {
    const current = this.workspaceState.get<JobSummary[]>(JOBS_RECENT_KEY, []);
    const next: JobSummary[] = [
      {
        id: state.id,
        name: state.name,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        status: state.status,
        progress: state.progress,
        details: state.details,
        ...(batchCounts(state.result) ? { result: sanitizeBatchResult(state.result) } : {})
      },
      ...current.filter((item) => item.id !== state.id)
    ].slice(0, normalizeRecentLimit(this.getRecentLimit()));

    await this.workspaceState.update(JOBS_RECENT_KEY, next);
  }

  private emit(job: JobRuntimeState): void {
    const cloned = { ...job, logs: [...job.logs] };
    for (const listener of this.listeners) {
      listener(cloned);
    }
  }
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeRecentLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_RECENT_LIMIT;
  }

  return Math.min(200, value);
}

function sanitizeLogMessage(input: string): string {
  return redactString(input);
}

function batchCounts(result: unknown): { successCount: number; failureCount: number } | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const counts = result as { successCount?: unknown; failureCount?: unknown };
  return typeof counts.successCount === 'number' && typeof counts.failureCount === 'number'
    ? counts as { successCount: number; failureCount: number } : undefined;
}

function sanitizeBatchResult(result: unknown): unknown {
  return JSON.parse(redactString(JSON.stringify(result))) as unknown;
}
