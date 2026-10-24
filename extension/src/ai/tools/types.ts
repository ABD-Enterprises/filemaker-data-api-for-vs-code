import type { EnterpriseFeatureId, FeatureGuardResult } from '../../enterprise/roleGuard';
import type {
  ConnectionProfile,
  EditRecordResult,
  FileMakerRecord,
  FindRecordsRequest,
  FindRecordsResult,
  RunScriptRequest,
  RunScriptResult,
  SchemaMetadataResult
} from '../../types/fm';
import type { AuditEntry } from '../aiAudit';
import type { AiSettings } from '../aiSettings';
import type { AiToolDefinition } from '../aiToolDefinitions';
import type { HiddenFields } from '../aiText';

export interface ConfirmSpec {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
}

/** What the tools pass to the client with each request. */
export interface Control {
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

export interface AiToolDeps {
  /** Read fresh for every call, so a settings change applies at once. */
  settings(): AiSettings;
  /** `filemaker.features.ai.enabled` (restrict-only). */
  featureSwitchOn(): boolean;
  featureGuard(feature: EnterpriseFeatureId): FeatureGuardResult;
  isTrusted(): boolean;
  isOffline(): boolean;
  getProfile(id: string): Promise<ConnectionProfile | undefined>;
  client: {
    listLayouts(profile: ConnectionProfile, control?: Control): Promise<string[]>;
    listScripts(profile: ConnectionProfile, control?: Control): Promise<string[]>;
    getRecord(profile: ConnectionProfile, layout: string, recordId: string, control?: Control): Promise<FileMakerRecord>;
    findRecords(profile: ConnectionProfile, layout: string, body: FindRecordsRequest, control?: Control): Promise<FindRecordsResult>;
    editRecord(
      profile: ConnectionProfile,
      layout: string,
      recordId: string,
      fieldData: Record<string, unknown>,
      control?: Control,
      options?: { modId?: string }
    ): Promise<EditRecordResult>;
    createRecord(profile: ConnectionProfile, layout: string, fieldData: Record<string, unknown>, control?: Control): Promise<EditRecordResult>;
    deleteRecord(profile: ConnectionProfile, layout: string, recordId: string, control?: Control): Promise<EditRecordResult>;
    runScript(profile: ConnectionProfile, request: RunScriptRequest, control?: Control): Promise<RunScriptResult>;
  };
  schema: { getLayoutSchema(profile: ConnectionProfile, layout: string): Promise<SchemaMetadataResult> };
  ui: {
    /** A modal the user must answer; true only for an explicit confirm. */
    confirm(spec: ConfirmSpec): Promise<boolean>;
    /** Tells the user that a request was cancelled while a dialog of theirs is still open. */
    notifyCancelled?(): void;
    /** A text prompt; undefined when dismissed. */
    input(spec: { title: string; prompt: string }): Promise<string | undefined>;
  };
  audit: { record(entry: AuditEntry): Promise<void> };
  now(): number;
}

export interface AiCallContext {
  signal?: AbortSignal;
  /** What the caller says it is (for example an MCP client name). Audit only; never shown as fact. */
  client?: string;
}

export interface AiStatus {
  killed: boolean;
  recordsUsed: number;
  recordQuota: number;
  writesUsed: number;
  writeCap: number;
}

export type Obj = Record<string, unknown>;

export interface LayoutFields {
  names: Set<string>;
  containers: Set<string>;
  readOnly: Map<string, string>;
  types: Map<string, string>;
}

export interface Trace {
  client?: string;
  layout?: string;
  script?: string;
  recordIds?: string[];
  confirmed: boolean | null;
  declined?: boolean;
  note?: string;
}

export interface Env {
  profile: ConnectionProfile;
  control: Control;
  hidden: HiddenFields;
  trace: Trace;
  definition: AiToolDefinition;
}
