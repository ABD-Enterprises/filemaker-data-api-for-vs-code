import { getHashes } from 'crypto';
import * as path from 'path';

import * as vscode from 'vscode';

import type { EnterpriseRole, PerformanceMode, SavedQueryScope, SchemaSnapshotStorage } from '../types/fm';
import type { LogLevel } from './logger';
import type { SecretFallbackMode } from './secretStore';

/**
 * Lazily computed allow-list of crypto hash algorithms available on this Node
 * runtime. We cache it because getHashes() is moderately expensive and the set
 * is fixed for the process lifetime.
 */
let cachedHashAlgorithms: Set<string> | undefined;
function supportedHashAlgorithms(): Set<string> {
  if (!cachedHashAlgorithms) {
    cachedHashAlgorithms = new Set(getHashes().map((name) => name.toLowerCase()));
  }
  return cachedHashAlgorithms;
}

/** Exported for tests so they can reset the cache after mocking getHashes. */
export function resetSupportedHashAlgorithmCacheForTesting(): void {
  cachedHashAlgorithms = undefined;
}

interface SettingsServiceOptions {
  getConfiguration?: (section?: string) => vscode.WorkspaceConfiguration;
  isWorkspaceTrusted?: () => boolean;
}

export class SettingsService {
  private readonly getConfiguration: (section?: string) => vscode.WorkspaceConfiguration;
  private readonly isWorkspaceTrusted: () => boolean;

  /**
   * Tracks which deprecated `filemakerDataApiTools.*` setting names we've already
   * surfaced to the user this session. Lets `getDeprecatedSettingsUsed` report
   * once per key so onActivate can show a single toast covering everything.
   */
  private readonly deprecatedKeysSeen = new Set<string>();

  public constructor(options?: SettingsServiceOptions) {
    this.getConfiguration = options?.getConfiguration ?? ((section) => vscode.workspace.getConfiguration(section));
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted);
  }

  /**
   * Prefer the modern `filemaker.<key>` value; fall back to the deprecated
   * `filemakerDataApiTools.<oldKey>` when the new one isn't explicitly set.
   * Records the deprecated key into deprecatedKeysSeen so the caller can
   * surface a one-time deprecation toast.
   */
  private getPreferred<T>(
    newSection: string,
    newKey: string,
    oldSection: string,
    oldKey: string,
    defaultValue: T
  ): T {
    const newConfig = this.getConfiguration(newSection).inspect<T>(newKey);
    if (
      newConfig &&
      (newConfig.globalValue !== undefined ||
        newConfig.workspaceValue !== undefined ||
        newConfig.workspaceFolderValue !== undefined)
    ) {
      return this.getConfiguration(newSection).get<T>(newKey, defaultValue);
    }
    const oldConfig = this.getConfiguration(oldSection).inspect<T>(oldKey);
    const oldExplicit =
      oldConfig &&
      (oldConfig.globalValue !== undefined ||
        oldConfig.workspaceValue !== undefined ||
        oldConfig.workspaceFolderValue !== undefined);
    if (oldExplicit) {
      this.deprecatedKeysSeen.add(`${oldSection}.${oldKey}`);
      return this.getConfiguration(oldSection).get<T>(oldKey, defaultValue);
    }
    return this.getConfiguration(newSection).get<T>(newKey, defaultValue);
  }

  /** Returns the deprecated setting keys observed this session and clears the set. */
  public consumeDeprecatedSettingsUsed(): string[] {
    const out = [...this.deprecatedKeysSeen];
    this.deprecatedKeysSeen.clear();
    return out;
  }

  public getLoggingLevel(): LogLevel {
    const configured = this.getPreferred<string | undefined>(
      'filemaker',
      'logging.level',
      'filemakerDataApiTools',
      'logLevel',
      undefined
    );

    if (configured === 'debug' || configured === 'info' || configured === 'warn' || configured === 'error') {
      return configured;
    }

    return 'info';
  }

  public getRequestTimeoutMs(): number {
    const configured = this.getPreferred<number>(
      'filemaker',
      'requestTimeoutMs',
      'filemakerDataApiTools',
      'requestTimeoutMs',
      15_000
    );
    if (!Number.isFinite(configured)) {
      return 15_000;
    }

    return clamp(Math.round(configured), 1_000, 120_000);
  }

  public getDefaultApiBasePath(): string {
    const configured = this.getPreferred<string>(
      'filemaker',
      'defaultApiBasePath',
      'filemakerDataApiTools',
      'defaultApiBasePath',
      '/fmi/data'
    );

    return normalizeApiPath(configured, '/fmi/data');
  }

  public getWebDirectBasePath(): string {
    const configured = this.getConfiguration('filemaker').get<string>(
      'webDirect.basePath',
      '/fmi/webd'
    );

    return normalizeApiPath(configured, '/fmi/webd');
  }

  public getDefaultApiVersionPath(): string {
    const configured = this.getPreferred<string>(
      'filemaker',
      'defaultApiVersionPath',
      'filemakerDataApiTools',
      'defaultApiVersionPath',
      'vLatest'
    );
    const trimmed = configured.trim();

    return trimmed.length > 0 ? trimmed.replace(/^\/+|\/+$/g, '') : 'vLatest';
  }

  public getSavedQueriesScope(): SavedQueryScope {
    const configured = this.getConfiguration('filemaker').get<string>('savedQueries.scope', 'workspace');
    return configured === 'global' ? 'global' : 'workspace';
  }

  public getSchemaCacheTtlSeconds(): number {
    const configured = this.getConfiguration('filemaker').get<number>('schema.cacheTtlSeconds', 300);
    if (!Number.isFinite(configured)) {
      return 300;
    }

    return clamp(Math.round(configured), 10, 86_400);
  }

  public isSchemaMetadataEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('schema.metadataEnabled', true);
  }

  public getHistoryMaxEntries(): number {
    const configured = this.getConfiguration('filemaker').get<number>('history.maxEntries', 10);
    if (!Number.isInteger(configured) || configured <= 0) {
      return 10;
    }

    return clamp(configured, 1, 200);
  }

  public shouldIncludeAuthInSnippetsByDefault(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('snippets.includeAuthByDefault', false);
  }

  public isScriptRunnerEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('features.scriptRunner.enabled', true);
  }

  public getSchemaSnapshotsStorage(): SchemaSnapshotStorage {
    const configured = this.getConfiguration('filemaker').get<string>(
      'schema.snapshots.storage',
      this.isWorkspaceTrusted() ? 'workspaceFiles' : 'workspaceState'
    );

    if (!this.isWorkspaceTrusted()) {
      return 'workspaceState';
    }

    return configured === 'workspaceState' ? 'workspaceState' : 'workspaceFiles';
  }

  public getSnapshotsMaxPerLayout(): number {
    const configured = this.getConfiguration('filemaker').get<number>('schema.snapshots.maxPerLayout', 20);
    if (!Number.isFinite(configured)) {
      return 20;
    }

    return clamp(Math.round(configured), 1, 100);
  }

  public isSchemaDiagnosticsEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('schema.diagnostics.enabled', false);
  }

  public getTypegenOutputDir(): string {
    const configured = this.getConfiguration('filemaker').get<string>('typegen.outputDir', 'filemaker-types');
    return sanitizeRelativeDir(configured, 'filemaker-types');
  }

  public getBatchMaxRecords(): number {
    const configured = this.getConfiguration('filemaker').get<number>('batch.maxRecords', 10_000);
    if (!Number.isFinite(configured)) {
      return 10_000;
    }

    return clamp(Math.round(configured), 1, 1_000_000);
  }

  public getBatchConcurrency(): number {
    const configured = this.getConfiguration('filemaker').get<number>('batch.concurrency', 4);
    if (!Number.isFinite(configured)) {
      return 4;
    }

    return clamp(Math.round(configured), 1, 10);
  }

  public getBatchDryRunDefault(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('batch.dryRunDefault', true);
  }

  public isRecordEditEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('features.recordEdit.enabled', true);
  }

  public isBatchEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('features.batch.enabled', true);
  }

  public isEnterpriseModeEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('enterprise.mode', false);
  }

  /**
   * Controls whether the advanced/diagnostic command palette entries
   * (Show Jobs, Open Diagnostics Dashboard, Circuit Breaker, plugins,
   * profile import/export) surface in the FileMaker command palette.
   * Default false to keep the palette focused for new users.
   */
  public isPowerUserModeEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('advanced.powerUserMode', false);
  }

  public getEnterpriseRole(): EnterpriseRole {
    const configured = this.getConfiguration('filemaker').get<string>('enterprise.role', 'developer');
    if (configured === 'viewer' || configured === 'developer' || configured === 'admin') {
      return configured;
    }

    return 'developer';
  }

  public getPerformanceMode(): PerformanceMode {
    const configured = this.getConfiguration('filemaker').get<string>('performance.mode', 'standard');
    return configured === 'high-scale' ? 'high-scale' : 'standard';
  }

  public isOfflineModeEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('offline.mode', false);
  }

  public getOfflineStaleCacheWarnHours(): number {
    const configured = this.getConfiguration('filemaker').get<number>('offline.staleCacheWarnHours', 24);
    if (!Number.isFinite(configured) || configured < 0) {
      return 24;
    }
    return Math.round(configured);
  }

  /**
   * Returns a hash algorithm name that is guaranteed to be supported by the
   * current Node `crypto` runtime. Unknown / empty values silently fall back to
   * `sha256` and are reported via the optional warning callback so the user
   * sees the rejection.
   */
  public getSchemaHashAlgorithm(onInvalid?: (configured: string) => void): string {
    const raw = this.getConfiguration('filemaker').get<string>('schema.hashAlgorithm', 'sha256').trim();
    if (raw.length === 0) {
      return 'sha256';
    }
    const supported = supportedHashAlgorithms();
    const normalized = raw.toLowerCase();
    if (supported.has(normalized)) {
      return raw;
    }
    onInvalid?.(raw);
    return 'sha256';
  }

  public isTelemetryEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('telemetry.enabled', false);
  }

  public getConnectBackoffPolicy(): {
    maxRetries: number;
    initialMs: number;
    maxMs: number;
    multiplier: number;
  } {
    const config = this.getConfiguration('filemaker');
    const maxRetries = config.get<number>('connect.maxRetries', 3);
    const initialMs = config.get<number>('connect.backoffInitialMs', 1_000);
    const maxMs = config.get<number>('connect.backoffMaxMs', 30_000);
    const multiplier = config.get<number>('connect.backoffMultiplier', 2);
    return {
      maxRetries: clamp(Number.isFinite(maxRetries) ? Math.round(maxRetries) : 3, 0, 10),
      initialMs: clamp(Number.isFinite(initialMs) ? Math.round(initialMs) : 1_000, 100, 60_000),
      maxMs: clamp(Number.isFinite(maxMs) ? Math.round(maxMs) : 30_000, 1_000, 300_000),
      multiplier:
        Number.isFinite(multiplier) && multiplier >= 1 ? Math.min(10, multiplier) : 2
    };
  }

  public getBridgeRateLimitConfig(): { perSecond: number; burst: number; budget: number } {
    const config = this.getConfiguration('filemaker');
    const perSecond = config.get<number>('fmWeb.bridge.rateLimitPerSecond', 20);
    const burst = config.get<number>('fmWeb.bridge.rateLimitBurst', 60);
    const budget = config.get<number>('fmWeb.bridge.requestBudget', 10_000);
    return {
      perSecond: clamp(Number.isFinite(perSecond) ? Math.round(perSecond) : 20, 1, 1_000),
      burst: clamp(Number.isFinite(burst) ? Math.round(burst) : 60, 1, 10_000),
      budget: clamp(Number.isFinite(budget) ? Math.round(budget) : 10_000, 100, 10_000_000)
    };
  }

  public getConnectionWizardTestPolicy(): 'off' | 'warn' | 'block' {
    const configured = this.getConfiguration('filemaker').get<string>(
      'connectionWizard.requireTestBeforeSave',
      'warn'
    );
    if (configured === 'off' || configured === 'block') {
      return configured;
    }
    return 'warn';
  }

  public getSessionMaxAgeMs(): number {
    const minutes = this.getConfiguration('filemaker').get<number>('session.maxAgeMinutes', 14);
    if (!Number.isFinite(minutes)) {
      return 14 * 60_000;
    }
    return clamp(Math.round(minutes), 1, 30) * 60_000;
  }

  public getSessionRefreshLeadMs(): number {
    const seconds = this.getConfiguration('filemaker').get<number>('session.refreshLeadSeconds', 30);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return 30_000;
    }
    return clamp(Math.round(seconds), 0, 300) * 1_000;
  }

  public getSecretsFallbackMode(): SecretFallbackMode {
    const configured = this.getConfiguration('filemaker').get<string>(
      'secrets.fallback',
      'vscode-only'
    );
    if (configured === 'workspace-state' || configured === 'disabled') {
      return configured;
    }
    return 'vscode-only';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeApiPath(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  if (!trimmed.startsWith('/')) {
    return `/${trimmed.replace(/\/+$/, '')}`;
  }

  return trimmed.replace(/\/+$/, '');
}

function sanitizeRelativeDir(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    return fallback;
  }

  if (normalized.includes('..')) {
    return fallback;
  }

  if (path.isAbsolute(normalized)) {
    return fallback;
  }

  return normalized;
}
