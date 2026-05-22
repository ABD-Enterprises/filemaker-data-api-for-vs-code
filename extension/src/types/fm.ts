export type AuthMode = 'direct' | 'proxy';
export type SavedQueryScope = 'workspace' | 'global';
export type SchemaSnapshotStorage = 'workspaceState' | 'workspaceFiles';
export type SchemaSnapshotSource = 'manual' | 'auto';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type BatchExportFormat = 'jsonl' | 'csv';
export type EnterpriseRole = 'viewer' | 'developer' | 'admin';
export type PerformanceMode = 'standard' | 'high-scale';

export interface ConnectionProfile {
  id: string;
  name: string;
  serverUrl: string;
  database: string;
  authMode: AuthMode;
  username?: string;
  apiBasePath?: string;
  apiVersionPath?: string;
  proxyEndpoint?: string;
}

export interface FileMakerMessage {
  code: string;
  message: string;
}

export interface FileMakerEnvelope<TResponse extends Record<string, unknown>> {
  response: TResponse;
  messages: FileMakerMessage[];
}

export interface FileMakerLayoutInfo {
  name: string;
}

export interface FileMakerRecord {
  recordId: string;
  modId?: string;
  fieldData: Record<string, unknown>;
  portalData?: Record<string, Array<Record<string, unknown>>>;
  [key: string]: unknown;
}

export interface FindRecordsRequest {
  query: Array<Record<string, unknown>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface FindRecordsResult {
  data: FileMakerRecord[];
  dataInfo?: Record<string, unknown>;
}

export interface EditRecordResult {
  recordId: string;
  modId?: string;
  messages: FileMakerMessage[];
  response: Record<string, unknown>;
}

export interface SavedQuery {
  id: string;
  name: string;
  profileId: string;
  database?: string;
  layout: string;
  findJson: Array<Record<string, unknown>>;
  sortJson?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface SavedQueriesDocument {
  schemaVersion: number;
  queries: SavedQuery[];
}

export interface FileMakerFieldMetadata {
  name: string;
  result?: string;
  type?: string;
  repetitions?: number;
  validation?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ValueListItem {
  value: string;
  displayValue: string;
}

export interface ValueList {
  name: string;
  values: ValueListItem[];
}

export interface SchemaMetadataResult {
  supported: boolean;
  fromCache: boolean;
  message?: string;
  metadata?: Record<string, unknown>;
  fields: FileMakerFieldMetadata[];
}

export interface SchemaSnapshot {
  id: string;
  profileId: string;
  layout: string;
  capturedAt: string;
  source: SchemaSnapshotSource;
  metadata: Record<string, unknown>;
  schemaVersion: number;
}

export interface SchemaSnapshotSummary {
  id: string;
  profileId: string;
  layout: string;
  capturedAt: string;
  source: SchemaSnapshotSource;
  schemaVersion: number;
}

export interface SchemaSnapshotDocument {
  snapshot: SchemaSnapshot;
}

export interface FieldDiffAttributeChange {
  attribute: string;
  before?: unknown;
  after?: unknown;
}

export interface SchemaFieldChanged {
  fieldName: string;
  before: FileMakerFieldMetadata;
  after: FileMakerFieldMetadata;
  changes: FieldDiffAttributeChange[];
}

export interface SchemaDiffSummary {
  added: number;
  removed: number;
  changed: number;
}

export interface SchemaDiffResult {
  profileId: string;
  layout: string;
  olderSnapshotId?: string;
  newerSnapshotId?: string;
  comparedAt: string;
  added: FileMakerFieldMetadata[];
  removed: FileMakerFieldMetadata[];
  changed: SchemaFieldChanged[];
  summary: SchemaDiffSummary;
  hasChanges: boolean;
}

export interface GeneratedLayoutArtifacts {
  layout: string;
  filePath: string;
  content: string;
  metadataHash: string;
}

export interface GeneratedSnippetsArtifacts {
  filePath: string;
  content: string;
}

export interface GeneratedTypeScriptClientArtifacts {
  directory: string;
  typesPath: string;
  clientPath: string;
  readmePath: string;
  layouts: string[];
}

export interface RecordDraftValidationError {
  field: string;
  message: string;
}

export interface RecordDraftValidationResult {
  valid: boolean;
  errors: RecordDraftValidationError[];
}

export interface RecordPatchPreview {
  changedFields: string[];
  patch: Record<string, unknown>;
}

export interface RunScriptRequest {
  layout: string;
  scriptName: string;
  scriptParam?: string;
  recordId?: string;
}

export interface RunScriptResult {
  response: Record<string, unknown>;
  messages: FileMakerMessage[];
}

export interface RequestHistoryEntry {
  id: string;
  requestId?: string;
  timestamp: string;
  profileId: string;
  layout?: string;
  operation: string;
  durationMs: number;
  success: boolean;
  httpStatus?: number;
  message?: string;
}

export interface RequestHistoryRecordInput {
  requestId?: string;
  profileId: string;
  layout?: string;
  operation: string;
  durationMs: number;
  success: boolean;
  httpStatus?: number;
  message?: string;
}

export interface RequestHistoryRecorder {
  record(entry: RequestHistoryRecordInput): Promise<void>;
}

export interface RequestMetricsEntry {
  requestId: string;
  timestamp: string;
  profileId: string;
  operation: string;
  endpoint: string;
  durationMs: number;
  success: boolean;
  httpStatus?: number;
  reauthCount: number;
  cacheHit: boolean;
  timedOut: boolean;
}

export interface RequestMetricsRecordInput {
  requestId: string;
  profileId: string;
  operation: string;
  endpoint: string;
  durationMs: number;
  success: boolean;
  httpStatus?: number;
  reauthCount?: number;
  cacheHit?: boolean;
  timedOut?: boolean;
}

export interface RequestMetricsRecorder {
  record(entry: RequestMetricsRecordInput): Promise<void>;
}

export interface JobLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface JobSummary {
  id: string;
  name: string;
  startedAt: string;
  finishedAt?: string;
  status: JobStatus;
  progress: number;
  details?: string;
}

export interface JobRuntimeState<T = unknown> extends JobSummary {
  logs: JobLogEntry[];
  result?: T;
}

export interface JobContext {
  reportProgress(percent: number, details?: string): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  isCancellationRequested(): boolean;
}

export interface BatchExportOptions {
  format: BatchExportFormat;
  maxRecords: number;
  outputPath: string;
  pageSize?: number;
}

export interface BatchExportResult {
  outputPath: string;
  format: BatchExportFormat;
  exportedRecords: number;
  truncated: boolean;
}

export interface BatchUpdateEntry {
  recordId: string;
  fieldData: Record<string, unknown>;
}

export interface BatchUpdateOptions {
  dryRun: boolean;
  concurrency: number;
}

export interface BatchUpdateFailure {
  recordId: string;
  reason: string;
}

export interface BatchUpdateResult {
  dryRun: boolean;
  total: number;
  attempted: number;
  successCount: number;
  failureCount: number;
  failures: BatchUpdateFailure[];
}

export interface EnvironmentSet {
  id: string;
  name: string;
  profiles: string[];
  createdAt: string;
}

export interface EnvironmentSetDocument {
  schemaVersion: number;
  items: EnvironmentSet[];
}

export interface EnvironmentLayoutMatrixRow {
  layout: string;
  presence: Record<string, boolean>;
  metadataHashes: Record<string, string | undefined>;
  scripts: Record<string, string[]>;
}

export interface EnvironmentCompareSummary {
  profileCount: number;
  totalLayouts: number;
  differentLayouts: number;
}

export interface EnvironmentCompareResult {
  environmentSetId: string;
  environmentSetName: string;
  generatedAt: string;
  rows: EnvironmentLayoutMatrixRow[];
  summary: EnvironmentCompareSummary;
}

export interface EnvironmentFieldDiff {
  fieldName: string;
  addedIn?: string[];
  removedIn?: string[];
  changedIn?: Array<{
    profileId: string;
    changes: Array<{ attribute: string; before?: unknown; after?: unknown }>;
  }>;
}

export interface LayoutEnvironmentDiffResult {
  environmentSetId: string;
  environmentSetName: string;
  generatedAt: string;
  layout: string;
  baselineProfileId: string;
  profileResults: Array<{
    profileId: string;
    available: boolean;
    metadataHash?: string;
    scripts: string[];
    addedFields: string[];
    removedFields: string[];
    changedFields: Array<{
      fieldName: string;
      attributes: string[];
    }>;
  }>;
}

export interface MultiProfileBatchRequest {
  profiles: string[];
  layout: string;
  query: FindRecordsRequest;
}

export interface MultiProfileBatchResult {
  profileId: string;
  success: boolean;
  recordCount: number;
  error?: string;
}

export function isProxyProfile(profile: ConnectionProfile): boolean {
  return profile.authMode === 'proxy';
}
