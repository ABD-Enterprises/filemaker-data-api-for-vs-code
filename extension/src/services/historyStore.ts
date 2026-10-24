import { randomUUID } from 'crypto';

import type * as vscode from 'vscode';

import type { RequestHistoryEntry, RequestHistoryRecordInput, RequestHistoryRecorder } from '../types/fm';
import { redactString } from '../utils/redact';

const HISTORY_KEY = 'filemaker.history.entries';

export class HistoryStore implements RequestHistoryRecorder {
  private readonly getMaxEntries: () => number;

  public constructor(
    private readonly workspaceState: vscode.Memento,
    options?: {
      getMaxEntries?: () => number;
    }
  ) {
    this.getMaxEntries = options?.getMaxEntries ?? (() => 10);
  }

  public listEntries(): RequestHistoryEntry[] {
    return this.workspaceState.get<RequestHistoryEntry[]>(HISTORY_KEY, []);
  }

  public getEntry(id: string): RequestHistoryEntry | undefined {
    return this.listEntries().find((entry) => entry.id === id);
  }

  public async clear(): Promise<void> {
    await this.workspaceState.update(HISTORY_KEY, []);
  }

  public async record(entry: RequestHistoryRecordInput): Promise<void> {
    const existing = this.listEntries();
    const maxEntries = normalizeMaxEntries(this.getMaxEntries());

    const enriched: RequestHistoryEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
      message: entry.message ? redactString(entry.message) : undefined
    };

    const next = [enriched, ...existing].slice(0, maxEntries);
    await this.workspaceState.update(HISTORY_KEY, next);
  }
}

function normalizeMaxEntries(configured: number): number {
  if (!Number.isInteger(configured) || configured <= 0) {
    return 10;
  }

  return Math.min(configured, 200);
}
