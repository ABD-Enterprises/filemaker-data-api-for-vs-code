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
      cancel: () => {
        controller.cancelled = true;
        if (state.status === 'running' || state.status === 'queued') {
          state.status = 'cancelling';
          this.emit(state);
        }
      },
      getState: () => ({ ...state, logs: [...state.logs] })
    };
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
        if (result && typeof result === 'object' && 'attempted' in result && 'total' in result) {
          state.details = `Cancelled after ${result.attempted} of ${result.total}`;
        }
      } else {
        state.status = 'completed';
        state.progress = 100;
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
        result: state.result
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

export function jobStatusText(job: Pick<JobSummary, 'status' | 'details'>): string {
  return job.status === 'cancelled' && job.details ? job.details : job.status;
}
