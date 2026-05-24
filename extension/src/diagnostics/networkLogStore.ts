import { randomUUID } from 'crypto';

import type * as vscode from 'vscode';

import type { NetworkLogRecordInput, NetworkLogRecorder } from '../types/fm';
import { redactHeaders, redactString, redactValue } from '../utils/redact';

export interface NetworkLogEntry {
  id: string;
  requestId: string;
  timestamp: string;
  method: string;
  url: string;
  relativeUrl: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseStatus?: number;
  responseHeaders: Record<string, string>;
  responseBody?: unknown;
  durationMs: number;
  errorMessage?: string;
}

interface NetworkLogStoreOptions {
  getMaxEntries?: () => number;
  now?: () => Date;
  createEventEmitter?: () => vscode.EventEmitter<void>;
}

export class NetworkLogStore implements NetworkLogRecorder, vscode.Disposable {
  private readonly getMaxEntries: () => number;
  private readonly now: () => Date;
  private readonly onDidChangeEmitter?: vscode.EventEmitter<void>;
  private entries: NetworkLogEntry[] = [];

  public readonly onDidChange: vscode.Event<void>;

  public constructor(options?: NetworkLogStoreOptions) {
    this.getMaxEntries = options?.getMaxEntries ?? (() => 100);
    this.now = options?.now ?? (() => new Date());
    this.onDidChangeEmitter = options?.createEventEmitter?.();
    this.onDidChange = this.onDidChangeEmitter?.event ?? (() => ({ dispose: () => undefined }));
  }

  public listEntries(): NetworkLogEntry[] {
    return [...this.entries];
  }

  public async clear(): Promise<void> {
    this.entries = [];
    this.onDidChangeEmitter?.fire();
  }

  public async record(input: NetworkLogRecordInput): Promise<void> {
    const requestId = input.requestId || randomUUID();
    const entry: NetworkLogEntry = {
      id: randomUUID(),
      requestId,
      timestamp: this.now().toISOString(),
      method: input.method.toUpperCase(),
      url: redactString(input.url),
      relativeUrl: redactString(input.relativeUrl),
      requestHeaders: redactHeaders(input.requestHeaders) ?? {},
      requestBody: redactValue(input.requestBody),
      responseStatus: input.responseStatus,
      responseHeaders: redactHeaders(input.responseHeaders) ?? {},
      responseBody: redactValue(input.responseBody),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      errorMessage: input.errorMessage ? redactString(input.errorMessage) : undefined
    };

    this.entries = [entry, ...this.entries].slice(0, normalizeMaxEntries(this.getMaxEntries()));
    this.onDidChangeEmitter?.fire();
  }

  public dispose(): void {
    this.onDidChangeEmitter?.dispose();
  }
}

function normalizeMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return 100;
  }

  return Math.min(value, 100);
}
