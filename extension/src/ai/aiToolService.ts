import type { EnterpriseFeatureId, FeatureGuardResult } from '../enterprise/roleGuard';
import type {
  ConnectionProfile,
  EditRecordResult,
  FileMakerRecord,
  FindRecordsRequest,
  FindRecordsResult,
  RunScriptRequest,
  RunScriptResult,
  SchemaMetadataResult
} from '../types/fm';
import { FMClientError, isRecordModifiedConflict } from '../services/errors';
import { redactString } from '../utils/redact';
import type { AuditEntry } from './aiAudit';
import { explainFileMakerError } from './fileMakerErrors';
import { AiInputError, validateInput } from './aiSchema';
import type { AiSettings } from './aiSettings';
import {
  AI_TOOL_DEFINITIONS,
  MAX_FIELDS_PER_WRITE,
  MAX_RECORDS_PER_CALL,
  MAX_SCRIPT_PARAMETER_CHARS,
  MAX_WRITE_VALUE_CHARS,
  findToolDefinition,
  type AiToolDefinition
} from './aiToolDefinitions';
import {
  HIDDEN_MARKER,
  HiddenFields,
  baseFieldName,
  scrubGenericText,
  REDACTION_MARKER,
  displayText,
  exactFieldNameOrUndefined,
  safeNameOrUndefined
} from './aiText';

export const SESSION_RECORD_QUOTA = 500;
export const CALLS_PER_MINUTE = 30;
export const WRITES_PER_SESSION = 10;
export const WRITES_PER_MINUTE = 3;
export const MAX_RESULT_CHARS = 200_000;
const MAX_VALUE_CHARS = 2000;
const MAX_PORTAL_ROWS = 20;
const MAX_LAYOUTS_LISTED = 200;
const MAX_SCRIPT_RESULT_CHARS = 10_000;
const MINUTE_MS = 60_000;
/** A response body larger than this is refused by the client (not applied in proxy mode). */
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CONSENT_PROMPTS = 20;
const MAX_REFUSAL_AUDIT_PER_MINUTE = 10;

/** An error whose message is written for the model: it never carries a secret or the server address. */
export class AiToolError extends Error {
  public constructor(
    message: string,
    public readonly outcome: 'refused' | 'error' = 'refused'
  ) {
    super(message);
    this.name = 'AiToolError';
  }
}

export interface ConfirmSpec {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
}

/** What the tools pass to the client with each request. */
interface Control {
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
    /** A text prompt; undefined when dismissed. */
    input(spec: { title: string; prompt: string }): Promise<string | undefined>;
  };
  audit: { record(entry: AuditEntry): Promise<void> };
  now(): number;
}

export interface AiCallContext {
  signal?: AbortSignal;
}

export interface AiStatus {
  killed: boolean;
  recordsUsed: number;
  recordQuota: number;
  writesUsed: number;
  writeCap: number;
}

type Obj = Record<string, unknown>;

interface LayoutFields {
  names: Set<string>;
  containers: Set<string>;
  types: Map<string, string>;
}

/**
 * The tool core (ADR-0004). It owns policy, consent, caps, redaction and audit. A transport
 * (VS Code language-model tools today, MCP later) only passes a tool name and input in and
 * the result out; it adds no policy of its own.
 */
export class AiToolService {
  private killed = false;
  /** Records read this session, including records reserved by calls still in flight. */
  private recordsUsed = 0;
  private writesUsed = 0;
  private consentPrompts = 0;
  private readonly consentInFlight = new Map<string, Promise<boolean>>();
  private readonly refusalAuditTimes: number[] = [];
  private suppressedRefusals = 0;
  private readonly callTimes: number[] = [];
  private readonly writeTimes: number[] = [];
  private readonly consented = new Set<string>();
  private readonly declined = new Set<string>();

  public constructor(private readonly deps: AiToolDeps) {}

  /**
   * The kill switch. It changes nothing but the switch: counters, caps and layout approvals
   * survive an off/on cycle, so toggling cannot be used to get fresh quota. Only
   * `resetSession` (an explicit command that asks the user) clears them.
   */
  public setKilled(killed: boolean): void {
    this.killed = killed;
  }

  public isKilled(): boolean {
    return this.killed;
  }

  public resetSession(): void {
    this.recordsUsed = 0;
    this.writesUsed = 0;
    this.callTimes.length = 0;
    this.writeTimes.length = 0;
    this.consented.clear();
    this.declined.clear();
    this.consentPrompts = 0;
    this.consentInFlight.clear();
  }

  public status(): AiStatus {
    return {
      killed: this.killed,
      recordsUsed: this.recordsUsed,
      recordQuota: SESSION_RECORD_QUOTA,
      writesUsed: this.writesUsed,
      writeCap: WRITES_PER_SESSION
    };
  }

  /**
   * The tools that may be offered right now. Write and script tools are absent unless the
   * user switched them on. An untrusted workspace, offline mode, the kill switch or a policy
   * switch empties the list.
   */
  public listTools(): AiToolDefinition[] {
    if (this.baseRefusal() !== undefined) {
      return [];
    }
    const settings = this.deps.settings();
    return AI_TOOL_DEFINITIONS.filter(
      (tool) =>
        tool.kind === 'read' ||
        (tool.kind === 'write' && settings.allowWrites && this.featuresAllow(['recordEdit', 'writeOperations'])) ||
        (tool.kind === 'script' && settings.allowScripts && this.featuresAllow(['scriptRunner']))
    );
  }

  public async invoke(name: string, input: unknown, context: AiCallContext = {}): Promise<unknown> {
    const definition = findToolDefinition(name);
    if (!definition) {
      throw new AiToolError('Unknown tool.');
    }

    let profile: ConnectionProfile | undefined;
    try {
      profile = await this.gate(definition);
      this.takeCallSlot();
      validateInput(definition.inputSchema, input);
      context.signal?.throwIfAborted();
    } catch (error) {
      await this.audit(definition, profile, {}, error instanceof AiToolError || error instanceof AiInputError ? 'refused' : 'error', null, errorNote(error));
      throw toModelError(error, profile);
    }

    const trace: Trace = { confirmed: null };
    try {
      const result = await this.dispatch(definition, input as Obj, profile, context, trace);
      await this.audit(definition, profile, trace, trace.declined ? 'declined' : 'ok', trace.confirmed, trace.note);
      return result;
    } catch (error) {
      const outcome = trace.declined ? 'declined' : error instanceof AiToolError ? error.outcome : 'error';
      await this.audit(definition, profile, trace, outcome, trace.confirmed, errorNote(error));
      throw toModelError(error, profile);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Policy

  private featuresAllow(features: EnterpriseFeatureId[]): boolean {
    return features.every((feature) => this.deps.featureGuard(feature).allowed);
  }

  /** Reasons that block every tool; undefined when none applies. */
  private baseRefusal(): string | undefined {
    if (this.killed) {
      return 'AI tools are switched off for this session (kill switch in the status bar).';
    }
    if (!this.deps.settings().enabled) {
      return 'AI tools are off. The user can turn them on with the user setting filemaker.ai.enabled.';
    }
    if (!this.deps.featureSwitchOn()) {
      return 'AI tools are disabled by a filemaker.features.ai.enabled switch.';
    }
    const guard = this.deps.featureGuard('ai');
    if (!guard.allowed) {
      return guard.reason ?? 'AI tools are disabled by enterprise policy.';
    }
    if (!this.deps.isTrusted()) {
      return 'AI tools are unavailable in an untrusted workspace.';
    }
    if (this.deps.isOffline()) {
      return 'Offline mode is on; AI tools are unavailable, including reads.';
    }
    return undefined;
  }

  private async gate(definition: AiToolDefinition): Promise<ConnectionProfile | undefined> {
    const base = this.baseRefusal();
    if (base) {
      throw new AiToolError(base);
    }

    const settings = this.deps.settings();
    if (definition.kind === 'write') {
      if (!settings.allowWrites) {
        throw new AiToolError('Write tools are off. The user can turn them on with filemaker.ai.allowWrites.');
      }
      this.requireFeatures(['recordEdit', 'writeOperations']);
    } else if (definition.kind === 'script') {
      if (!settings.allowScripts) {
        throw new AiToolError('Script tools are off. The user can turn them on with filemaker.ai.allowScripts.');
      }
      this.requireFeatures(['scriptRunner']);
    }

    if (definition.name === 'fm_explain_error') {
      return undefined;
    }

    if (!settings.connection) {
      throw new AiToolError('No connection is chosen for AI use. The user sets filemaker.ai.connection.');
    }
    const profile = await this.deps.getProfile(settings.connection);
    if (!profile) {
      throw new AiToolError('The connection chosen for AI use does not exist.');
    }
    const access = profile.aiAccess ?? 'none';
    if (access === 'none' || (definition.kind !== 'read' && access !== 'write')) {
      throw new AiToolError(
        definition.kind === 'read'
          ? 'This connection is not enabled for AI use. The user can run "FileMaker: Set AI Access for Connection".'
          : 'This connection allows AI reads only. The user can run "FileMaker: Set AI Access for Connection" to allow writes.'
      );
    }
    return profile;
  }

  private requireFeatures(features: EnterpriseFeatureId[]): void {
    for (const feature of features) {
      const guard = this.deps.featureGuard(feature);
      if (!guard.allowed) {
        throw new AiToolError(guard.reason ?? 'This action is disabled by enterprise policy.');
      }
    }
  }

  private takeCallSlot(): void {
    const now = this.deps.now();
    prune(this.callTimes, now);
    if (this.callTimes.length >= CALLS_PER_MINUTE) {
      throw new AiToolError(`Rate limit: at most ${CALLS_PER_MINUTE} AI tool calls per minute. Wait and try again.`);
    }
    this.callTimes.push(now);
  }

  /** Counts a write attempt that reaches a confirmation; refuses beyond the caps. */
  private takeWriteSlot(): void {
    const now = this.deps.now();
    prune(this.writeTimes, now);
    if (this.writesUsed >= WRITES_PER_SESSION) {
      throw new AiToolError(`Write cap reached: ${WRITES_PER_SESSION} write attempts per session. The user can run "FileMaker: Start New AI Session".`);
    }
    if (this.writeTimes.length >= WRITES_PER_MINUTE) {
      throw new AiToolError(`Write cap: at most ${WRITES_PER_MINUTE} write attempts per minute. Wait and try again.`);
    }
    this.writesUsed += 1;
    this.writeTimes.push(now);
  }

  /**
   * Reserves up to `wanted` records of the session quota BEFORE the request is sent, so
   * parallel calls cannot each see the same remaining quota. Returns how many were reserved.
   * Settle with `settleRecords`.
   */
  private reserveRecords(wanted: number): number {
    const remaining = SESSION_RECORD_QUOTA - this.recordsUsed;
    if (remaining <= 0) {
      throw new AiToolError(`The record quota for this session (${SESSION_RECORD_QUOTA}) is used up.`);
    }
    const reserved = Math.min(wanted, remaining);
    this.recordsUsed += reserved;
    return reserved;
  }

  /** Gives back the part of a reservation that was not used (all of it if the request failed). */
  private settleRecords(reserved: number, returned: number): void {
    this.recordsUsed -= Math.max(0, reserved - returned);
  }

  /** Runs `request` with `wanted` records reserved; refunds what it did not return. */
  private async withRecords<T>(wanted: number, request: (limit: number) => Promise<{ value: T; returned: number }>): Promise<T> {
    const reserved = this.reserveRecords(wanted);
    let returned = 0;
    try {
      const result = await request(reserved);
      returned = result.returned;
      return result.value;
    } finally {
      this.settleRecords(reserved, returned);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Dispatch

  private async dispatch(
    definition: AiToolDefinition,
    input: Obj,
    profile: ConnectionProfile | undefined,
    context: AiCallContext,
    trace: Trace
  ): Promise<unknown> {
    if (definition.name === 'fm_explain_error') {
      return explainFileMakerError(input.code as number);
    }
    if (!profile) {
      throw new AiToolError('No connection.');
    }

    const control: Control = { signal: context.signal, maxResponseBytes: MAX_RESPONSE_BYTES };
    const definitionRef = definition;
    const hidden = new HiddenFields(this.deps.settings().hiddenFields);
    const env: Env = { profile, control, hidden, trace, definition: definitionRef };

    switch (definition.name) {
      case 'fm_list_layouts':
        return this.listLayouts(env);
      case 'fm_list_scripts':
        return this.listScripts(env);
      case 'fm_describe_layout':
        return this.describeLayout(env, input.layout as string);
      case 'fm_find_records':
        return this.findRecords(env, input);
      case 'fm_get_record':
        return this.getRecord(env, input.layout as string, input.recordId as string);
      case 'fm_edit_record':
        return this.editRecord(env, input);
      case 'fm_create_record':
        return this.createRecord(env, input);
      case 'fm_delete_record':
        return this.deleteRecord(env, input);
      case 'fm_run_script':
        return this.runScript(env, input);
      default:
        throw new AiToolError('Unknown tool.');
    }
  }

  // ---------------------------------------------------------------------------------------
  // Reads

  private async listLayouts(env: Env): Promise<unknown> {
    const layouts = await this.deps.client.listLayouts(env.profile, env.control);
    return listNames('layouts', layouts);
  }

  private async listScripts(env: Env): Promise<unknown> {
    const scripts = await this.deps.client.listScripts(env.profile, env.control);
    return listNames('scripts', scripts);
  }

  private async describeLayout(env: Env, layout: string): Promise<unknown> {
    await this.useLayout(env, layout);
    const schema = await this.layoutSchema(env, layout);
    let unusable = 0;
    const fields: Obj[] = [];
    for (const field of schema.fields) {
      if (env.hidden.isHidden(field.name)) {
        continue;
      }
      const name = usableFieldName(field.name);
      if (name === undefined) {
        unusable += 1;
        continue;
      }
      const type = field.result ?? field.type;
      fields.push({
        name,
        type: typeof type === 'string' ? type.slice(0, 30) : undefined,
        repetitions: typeof field.repetitions === 'number' && field.repetitions > 1 ? field.repetitions : undefined
      });
    }
    return { layout, fields, unusableFields: unusable > 0 ? unusable : undefined };
  }

  private async findRecords(env: Env, input: Obj): Promise<unknown> {
    const layout = input.layout as string;
    await this.useLayout(env, layout);
    const fields = await this.layoutFields(env, layout);

    const requests = input.requests as Array<{ fields: Record<string, string>; omit?: boolean }>;
    const query = requests.map((request) => {
      const entries = Object.entries(request.fields);
      if (entries.length === 0) {
        throw new AiToolError('Each find request needs at least one field.');
      }
      // No prototype, so a field called "__proto__" or "constructor" is only a key.
      const criteria = Object.create(null) as Obj;
      for (const [fieldName, value] of entries) {
        criteria[this.knownField(fields, fieldName)] = value;
      }
      if (request.omit === true) {
        criteria.omit = 'true';
      }
      return criteria;
    });
    if (query.every((criteria) => criteria.omit === 'true')) {
      throw new AiToolError('At least one find request must not be an omit request.');
    }

    const sort = ((input.sort as Array<{ field: string; order?: 'asc' | 'desc' }> | undefined) ?? []).map((item) => ({
      fieldName: this.knownField(fields, item.field),
      sortOrder: item.order === 'desc' ? 'descend' : 'ascend'
    }));

    const outcome = await this.withRecords((input.limit as number | undefined) ?? 20, async (limit) => {
      const body: FindRecordsRequest = {
        query,
        ...(sort.length > 0 ? { sort } : {}),
        limit,
        ...(input.offset !== undefined ? { offset: input.offset as number } : {})
      };
      const result = await this.deps.client.findRecords(env.profile, layout, body, env.control);
      const shaped = this.shapeRecords(result.data.slice(0, limit), fields, env);
      return { value: { result, shaped, limit }, returned: shaped.records.length };
    });

    env.trace.recordIds = outcome.shaped.records.map((record) => String(record.recordId));
    const foundCount = outcome.result.dataInfo?.foundCount;
    return this.finish({
      layout,
      foundCount: typeof foundCount === 'number' ? foundCount : undefined,
      records: outcome.shaped.records,
      truncated: outcome.shaped.truncated || outcome.result.data.length > outcome.limit,
      quota: this.quota()
    });
  }

  private async getRecord(env: Env, layout: string, recordId: string): Promise<unknown> {
    await this.useLayout(env, layout);
    const fields = await this.layoutFields(env, layout);
    const shaped = await this.withRecords(1, async () => {
      const record = await this.deps.client.getRecord(env.profile, layout, recordId, env.control);
      return { value: this.shapeRecords([record], fields, env), returned: 1 };
    });
    env.trace.recordIds = [recordId];
    return this.finish({ layout, records: shaped.records, truncated: shaped.truncated, quota: this.quota() });
  }

  private quota(): { used: number; limit: number } {
    return { used: this.recordsUsed, limit: SESSION_RECORD_QUOTA };
  }

  /** Enforces the result size cap on the way out. Each record is serialized once. */
  private finish(result: { records: unknown[]; truncated: boolean } & Obj): Obj {
    const records = result.records;
    const sizes = records.map((record) => JSON.stringify(record).length + 1);
    let total = JSON.stringify({ ...result, records: [], truncated: true }).length + sizes.reduce((sum, size) => sum + size, 0);
    while (total > MAX_RESULT_CHARS && records.length > 0) {
      total -= sizes.pop() as number;
      records.pop();
      result.truncated = true;
    }
    return result;
  }

  private shapeRecords(
    records: FileMakerRecord[],
    fields: LayoutFields,
    env: Env
  ): { records: Obj[]; truncated: boolean } {
    const shaped = records.slice(0, MAX_RECORDS_PER_CALL).map((record) => {
      const out: Obj = {
        recordId: String(record.recordId),
        modId: record.modId === undefined ? undefined : String(record.modId),
        fields: shapeValues(record.fieldData ?? {}, env, fields.containers)
      };
      if (record.portalData && typeof record.portalData === 'object') {
        const portals = Object.create(null) as Obj;
        for (const [portalName, rows] of Object.entries(record.portalData)) {
          const name = exactFieldNameOrUndefined(portalName);
          if (name === undefined || env.hidden.isHidden(portalName) || !Array.isArray(rows)) {
            continue;
          }
          portals[name] = rows.slice(0, MAX_PORTAL_ROWS).map((row) => shapeValues(row, env, new Set()));
        }
        out.portals = portals;
      }
      return out;
    });
    return { records: shaped, truncated: records.length > MAX_RECORDS_PER_CALL };
  }

  // ---------------------------------------------------------------------------------------
  // Writes

  private async editRecord(env: Env, input: Obj): Promise<unknown> {
    const layout = input.layout as string;
    const recordId = input.recordId as string;
    await this.useLayout(env, layout);
    const fields = await this.layoutFields(env, layout);
    const requested = this.validateWriteFields(fields, input.fields as Record<string, string>);

    const record = await this.withRecords(1, async () => ({
      value: await this.deps.client.getRecord(env.profile, layout, recordId, env.control),
      returned: 1
    }));
    env.trace.recordIds = [recordId];

    const changes = requested
      .map(([name, value]) => ({ name, oldValue: valueText(record.fieldData?.[name]), newValue: value }))
      .filter((change) => change.oldValue !== change.newValue);
    if (changes.length === 0) {
      // Reads one record (quota) but asks nothing, writes nothing and uses no write attempt.
      return { recordId, changed: false, message: 'Every given value already matches the record. Nothing was written.' };
    }

    if (input.dryRun === true) {
      return {
        dryRun: true,
        recordId,
        changes: changes.map((change) => ({
          field: change.name,
          old: valueForModel(change.oldValue, env.profile),
          new: change.newValue
        }))
      };
    }

    // Built before a write attempt is counted: it refuses anything the dialog could not show.
    const confirmation = buildEditConfirmation({
      profile: env.profile,
      layout,
      recordId,
      changes,
      description: input.description as string | undefined
    });
    this.takeWriteSlot();
    const confirmed = await this.deps.ui.confirm(confirmation);
    env.trace.confirmed = confirmed;
    if (!confirmed) {
      env.trace.declined = true;
      return { recordId, written: false, message: 'The user declined the change.' };
    }
    await this.recheck(env);

    const fieldData = Object.fromEntries(changes.map((change) => [change.name, change.newValue]));
    try {
      const result = await this.deps.client.editRecord(env.profile, layout, recordId, fieldData, env.control, {
        modId: record.modId === undefined ? undefined : String(record.modId)
      });
      return { recordId, written: true, modId: result.modId, fieldsChanged: changes.map((change) => change.name) };
    } catch (error) {
      if (isRecordModifiedConflict(error)) {
        throw new AiToolError('The record was changed by someone else after it was read, so nothing was written. Read it again and retry.', 'error');
      }
      throw error;
    }
  }

  private async createRecord(env: Env, input: Obj): Promise<unknown> {
    const layout = input.layout as string;
    await this.useLayout(env, layout);
    const fields = await this.layoutFields(env, layout);
    const requested = this.validateWriteFields(fields, input.fields as Record<string, string>);
    if (input.dryRun === true) {
      return { dryRun: true, wouldCreate: requested.map(([name, value]) => ({ field: name, new: value })) };
    }

    const confirmation = buildCreateConfirmation({
      profile: env.profile,
      layout,
      values: requested,
      description: input.description as string | undefined
    });
    this.takeWriteSlot();
    const confirmed = await this.deps.ui.confirm(confirmation);
    env.trace.confirmed = confirmed;
    if (!confirmed) {
      env.trace.declined = true;
      return { written: false, message: 'The user declined creating the record.' };
    }
    await this.recheck(env);

    const result = await this.deps.client.createRecord(
      env.profile,
      layout,
      Object.fromEntries(requested),
      env.control
    );
    env.trace.recordIds = [result.recordId];
    return { written: true, recordId: result.recordId, modId: result.modId };
  }

  private async deleteRecord(env: Env, input: Obj): Promise<unknown> {
    const layout = input.layout as string;
    const recordId = input.recordId as string;
    await this.useLayout(env, layout);
    const fields = await this.layoutFields(env, layout);
    const record = await this.withRecords(1, async () => ({
      value: await this.deps.client.getRecord(env.profile, layout, recordId, env.control),
      returned: 1
    }));
    env.trace.recordIds = [recordId];

    const snapshot = shapeValues(record.fieldData ?? {}, env, fields.containers);
    if (input.dryRun === true) {
      return { dryRun: true, recordId, wouldDelete: snapshot };
    }

    const confirmation = buildDeleteConfirmation({
      profile: env.profile,
      layout,
      recordId,
      snapshot,
      description: input.description as string | undefined
    });
    this.takeWriteSlot();
    const confirmed = await this.deps.ui.confirm(confirmation);
    if (!confirmed) {
      env.trace.confirmed = false;
      env.trace.declined = true;
      return { recordId, deleted: false, message: 'The user declined the deletion.' };
    }
    await this.recheck(env);

    const typed = await this.deps.ui.input({
      title: 'Delete record',
      prompt: `Type the record id ${recordId} to delete it. This cannot be undone. Dismiss to cancel.`
    });
    if (typed === undefined || typed.trim() !== recordId) {
      env.trace.confirmed = false;
      env.trace.declined = true;
      return { recordId, deleted: false, message: 'The deletion was not confirmed.' };
    }
    env.trace.confirmed = true;
    await this.recheck(env);

    // The record may have changed while the user decided; delete only what they saw.
    const fresh = await this.deps.client.getRecord(env.profile, layout, recordId, env.control);
    if (String(fresh.modId) !== String(record.modId)) {
      throw new AiToolError('The record changed while the deletion was being confirmed, so nothing was deleted. Read it again and retry.', 'error');
    }

    await this.deps.client.deleteRecord(env.profile, layout, recordId, env.control);
    return { recordId, deleted: true };
  }

  private async runScript(env: Env, input: Obj): Promise<unknown> {
    const layout = input.layout as string;
    const script = input.script as string;
    const allowlist = this.deps.settings().scriptAllowlist[env.profile.id] ?? [];
    if (!allowlist.includes(script)) {
      throw new AiToolError('That script is not on the user\'s allowlist for this connection (filemaker.ai.scriptAllowlist), so it cannot be run.');
    }
    await this.useLayout(env, layout);
    const scripts = await this.deps.client.listScripts(env.profile, env.control);
    if (!scripts.includes(script)) {
      throw new AiToolError('That script does not exist in the database.');
    }

    const parameter = input.parameter as string | undefined;
    const confirmation = buildScriptConfirmation({
      profile: env.profile,
      layout,
      script,
      parameter,
      description: input.description as string | undefined
    });
    this.takeWriteSlot();
    const confirmed = await this.deps.ui.confirm(confirmation);
    env.trace.confirmed = confirmed;
    if (!confirmed) {
      env.trace.declined = true;
      return { ran: false, message: 'The user declined running the script.' };
    }
    await this.recheck(env);

    const result = await this.deps.client.runScript(
      env.profile,
      { layout, scriptName: script, ...(parameter !== undefined ? { scriptParam: parameter } : {}) },
      env.control
    );
    const response = result.response ?? {};
    return {
      ran: true,
      scriptResult:
        typeof response.scriptResult === 'string'
          ? scrub(redactString(response.scriptResult), env.profile).slice(0, MAX_SCRIPT_RESULT_CHARS)
          : undefined,
      scriptError: typeof response.scriptError === 'string' ? response.scriptError : undefined
    };
  }

  private validateWriteFields(fields: LayoutFields, given: Record<string, string>): Array<[string, string]> {
    const entries = Object.entries(given);
    if (entries.length === 0) {
      throw new AiToolError('At least one field is required.');
    }
    if (entries.length > MAX_FIELDS_PER_WRITE) {
      throw new AiToolError(`At most ${MAX_FIELDS_PER_WRITE} fields per write: the approval dialog shows every field.`);
    }
    return entries.map(([name, value]) => {
      if (name.includes('::')) {
        throw new AiToolError('Related-record fields (Table::Field) cannot be written.');
      }
      const known = this.knownField(fields, name);
      if (fields.containers.has(known)) {
        throw new AiToolError('Container fields cannot be written by AI tools.');
      }
      if (Array.from(value).length > MAX_WRITE_VALUE_CHARS) {
        throw new AiToolError(`A value may have at most ${MAX_WRITE_VALUE_CHARS} characters: the approval dialog shows each value in full.`);
      }
      if (value.includes(REDACTION_MARKER) || value.includes(HIDDEN_MARKER)) {
        throw new AiToolError(`A value may not contain ${REDACTION_MARKER} or ${HIDDEN_MARKER}; those mark text the tools hid or redacted.`);
      }
      if (value.includes('\0')) {
        throw new AiToolError('A value may not contain a NUL character.');
      }
      return [known, value];
    });
  }

  /**
   * After a dialog and before anything is sent: run every policy check again. The kill
   * switch, `enabled`, `allowWrites`, trust, offline mode or the connection may have changed
   * while the dialog was open, and a person's "yes" does not outlast that.
   */
  private async recheck(env: Env): Promise<void> {
    try {
      const profile = await this.gate(env.definition);
      if (profile?.id !== env.profile.id) {
        throw new AiToolError('The connection for AI use changed.');
      }
    } catch (error) {
      if (error instanceof AiToolError) {
        throw new AiToolError(`Policy changed while a dialog was open, so nothing was written: ${error.message}`);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Shared helpers

  /** Checks the layout exists, is usable by name, and the user allowed reading it. */
  private async useLayout(env: Env, layout: string): Promise<void> {
    const layouts = await this.deps.client.listLayouts(env.profile, env.control);
    if (!layouts.includes(layout)) {
      throw new AiToolError('Unknown layout. Use a name from fm_list_layouts.');
    }
    if (safeNameOrUndefined(layout) === undefined) {
      throw new AiToolError('That layout\'s name cannot be used by AI tools.');
    }
    env.trace.layout = layout;

    const key = `${env.profile.id}\u0000${layout}`;
    const preset = this.deps.settings().readableLayouts[env.profile.id] ?? [];
    if (preset.includes(layout) || this.consented.has(key)) {
      return;
    }
    if (this.declined.has(key)) {
      throw new AiToolError('The user did not allow reading this layout.');
    }

    // One prompt per layout however many calls arrive at once, and a cap per session.
    let pending = this.consentInFlight.get(key);
    if (!pending) {
      if (this.consentPrompts >= MAX_CONSENT_PROMPTS) {
        throw new AiToolError('Too many layout approval requests this session. The user can run "FileMaker: Start New AI Session".');
      }
      this.consentPrompts += 1;
      const prompt = this.deps.ui
        .confirm({
          title: 'Allow an AI tool to read this layout?',
          message: `An AI tool asks to read layout ${displayText(layout, 64)} in connection ${displayText(env.profile.name, 64)}.`,
          detail: [
            'It will see field names and record values on this layout, including related and portal data reachable through it, up to the session limits.',
            'Anything it reads is sent to the AI model provider you chose.',
            `Account: ${displayText(accountName(env.profile), 64)}`
          ].join('\n'),
          confirmLabel: 'Allow for This Session'
        })
        .finally(() => this.consentInFlight.delete(key));
      this.consentInFlight.set(key, prompt);
      pending = prompt;
    }

    if (!(await pending)) {
      this.declined.add(key);
      env.trace.declined = true;
      throw new AiToolError('The user did not allow reading this layout.');
    }
    const refusal = this.baseRefusal();
    if (refusal) {
      throw new AiToolError(`Policy changed while a dialog was open: ${refusal}`);
    }
    this.consented.add(key);
  }

  private async layoutSchema(env: Env, layout: string): Promise<SchemaMetadataResult> {
    const schema = await this.deps.schema.getLayoutSchema(env.profile, layout);
    if (!schema.supported) {
      throw new AiToolError('Layout metadata is not available for this connection, so fields cannot be checked.');
    }
    return schema;
  }

  private async layoutFields(env: Env, layout: string): Promise<LayoutFields> {
    const schema = await this.layoutSchema(env, layout);
    const names = new Set<string>();
    const containers = new Set<string>();
    const types = new Map<string, string>();
    for (const field of schema.fields) {
      const name = usableFieldName(field.name);
      if (name === undefined || env.hidden.isHidden(name)) {
        continue;
      }
      names.add(name);
      const type = String(field.result ?? field.type ?? '').toLowerCase();
      types.set(name, type);
      if (type === 'container') {
        containers.add(name);
      }
    }
    return { names, containers, types };
  }

  /** A field the layout has and policy shows. Unknown and hidden give the same answer. */
  private knownField(fields: LayoutFields, name: string): string {
    if (!fields.names.has(name)) {
      throw new AiToolError(`Unknown or unavailable field ${displayText(name, 64)} on this layout. Use names from fm_describe_layout.`);
    }
    return name;
  }

  private async audit(
    definition: AiToolDefinition,
    profile: ConnectionProfile | undefined,
    trace: Partial<Trace>,
    outcome: AuditEntry['outcome'],
    confirmed: boolean | null,
    note: string | undefined
  ): Promise<void> {
    let text = note === undefined ? undefined : scrub(note, profile);
    // Refusals before any layout was touched cost nothing to produce, so they are logged at a
    // limited rate: a flood of them cannot push older write entries out of the log.
    if (outcome === 'refused' && trace.layout === undefined) {
      const now = this.deps.now();
      prune(this.refusalAuditTimes, now);
      if (this.refusalAuditTimes.length >= MAX_REFUSAL_AUDIT_PER_MINUTE) {
        this.suppressedRefusals += 1;
        return;
      }
      this.refusalAuditTimes.push(now);
      if (this.suppressedRefusals > 0) {
        text = `${text ?? ''} (${this.suppressedRefusals} earlier refusals were not logged)`.trim();
        this.suppressedRefusals = 0;
      }
    }

    await this.deps.audit.record({
      tool: definition.name,
      connection: profile?.name ?? '(none)',
      layout: trace.layout,
      recordIds: trace.recordIds,
      outcome,
      confirmed,
      note: text
    });
  }
}

interface Trace {
  layout?: string;
  recordIds?: string[];
  confirmed: boolean | null;
  declined?: boolean;
  note?: string;
}

interface Env {
  profile: ConnectionProfile;
  control: Control;
  hidden: HiddenFields;
  trace: Trace;
  definition: AiToolDefinition;
}

function prune(times: number[], now: number): void {
  while (times.length > 0 && now - (times[0] as number) >= MINUTE_MS) {
    times.shift();
  }
}

function valueText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function cut(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]` : value;
}

/** Names `omit` and `__proto__` collide with the find body and with object keys: not usable. */
function usableFieldName(name: unknown): string | undefined {
  const exact = exactFieldNameOrUndefined(name);
  if (exact === undefined) {
    return undefined;
  }
  const base = baseFieldName(exact).toLowerCase();
  return base === 'omit' || base === '__proto__' ? undefined : exact;
}

function listNames(key: 'layouts' | 'scripts', names: string[]): Obj {
  const listed = names.slice(0, MAX_LAYOUTS_LISTED).map((name) => {
    const safe = safeNameOrUndefined(name);
    return safe === undefined ? { name: '[name omitted]', usable: false } : { name: safe, usable: true };
  });
  return { [key]: listed, count: names.length, truncated: names.length > MAX_LAYOUTS_LISTED };
}

/** A container streaming URL or a data API path: it names the server and carries a session. */
const SERVER_URL_PATTERN = /\/Streaming(?:_SSL)?\/|[?&]RCType=|\/fmi\/data\//i;

/**
 * One value for the model: a container or server URL is dropped, the server's own address is
 * removed from other text, secrets are redacted, long text is cut. Names are never changed.
 */
function valueForModel(value: string, profile: ConnectionProfile): string {
  if (SERVER_URL_PATTERN.test(value)) {
    return '[container or server URL omitted]';
  }
  return cut(scrub(redactString(value), profile));
}

/** Record values for the model: hidden fields removed, containers dropped, URLs and secrets handled. */
function shapeValues(data: Record<string, unknown>, env: Pick<Env, 'hidden' | 'profile'>, containers: Set<string>): Obj {
  // No prototype, so a field named "__proto__" is only a key.
  const out = Object.create(null) as Obj;
  for (const [key, value] of Object.entries(data)) {
    const name = exactFieldNameOrUndefined(key);
    if (name === undefined || env.hidden.isHidden(key)) {
      continue;
    }
    if (containers.has(baseFieldName(key))) {
      out[name] = '[container field omitted]';
    } else if (typeof value === 'string') {
      out[name] = valueForModel(value, env.profile);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[name] = value;
    } else {
      out[name] = valueForModel(JSON.stringify(value) ?? '', env.profile);
    }
  }
  return out;
}

function accountName(profile: ConnectionProfile): string {
  return profile.username ?? (profile.authMode === 'proxy' ? '(set by the proxy)' : '(unknown)');
}

// -----------------------------------------------------------------------------------------
// Confirmations. Host facts first; every change shown in full; the model's own words last and
// labelled. A builder throws rather than build a dialog that would hide part of a write.

function hostFacts(profile: ConnectionProfile, layout: string): string[] {
  return [
    `Connection: ${displayText(profile.name, 64)}`,
    `Account: ${displayText(accountName(profile), 64)}`,
    `Layout: ${displayText(layout, 64)}`
  ];
}

function modelNote(description: string | undefined): string[] {
  return description
    ? ['', `The AI tool's own description (not verified): ${displayText(description, 200)}`]
    : [];
}

function assertShownInFull(count: number, values: string[]): void {
  if (count > MAX_FIELDS_PER_WRITE || values.some((value) => Array.from(value).length > MAX_WRITE_VALUE_CHARS)) {
    throw new AiToolError('This write is too large for the approval dialog to show in full, so it was refused.');
  }
}

const OLD_VALUE_SHOWN = 200;

export function buildEditConfirmation(args: {
  profile: ConnectionProfile;
  layout: string;
  recordId: string;
  changes: Array<{ name: string; oldValue: string; newValue: string }>;
  description?: string;
}): ConfirmSpec {
  assertShownInFull(args.changes.length, args.changes.map((change) => change.newValue));
  const lines = [
    ...hostFacts(args.profile, args.layout),
    `Record id: ${displayText(args.recordId, 20)}`,
    `Fields changed: ${args.changes.length}`,
    '',
    // New values and field names in full. An old value that is long is cut with its length
    // shown; it is replaced by the new value either way.
    ...args.changes.map(
      (change) =>
        `${displayText(change.name, 128)}: ${displayText(redactString(change.oldValue), OLD_VALUE_SHOWN)} -> ${displayText(change.newValue, MAX_WRITE_VALUE_CHARS)}`
    )
  ];
  return {
    title: 'An AI tool wants to change a record',
    message: 'An AI tool wants to change a FileMaker record. Approve only if you expected this change.',
    detail: [...lines, ...modelNote(args.description)].join('\n'),
    confirmLabel: 'Change Record'
  };
}

export function buildCreateConfirmation(args: {
  profile: ConnectionProfile;
  layout: string;
  values: Array<[string, string]>;
  description?: string;
}): ConfirmSpec {
  assertShownInFull(args.values.length, args.values.map(([, value]) => value));
  const lines = [
    ...hostFacts(args.profile, args.layout),
    `Fields set: ${args.values.length}`,
    '',
    ...args.values.map(([name, value]) => `${displayText(name, 128)}: ${displayText(value, MAX_WRITE_VALUE_CHARS)}`)
  ];
  return {
    title: 'An AI tool wants to create a record',
    message: 'An AI tool wants to create a FileMaker record. Approve only if you expected this.',
    detail: [...lines, ...modelNote(args.description)].join('\n'),
    confirmLabel: 'Create Record'
  };
}

export function buildDeleteConfirmation(args: {
  profile: ConnectionProfile;
  layout: string;
  recordId: string;
  snapshot: Obj;
  description?: string;
}): ConfirmSpec {
  const entries = Object.entries(args.snapshot);
  const lines = [
    ...hostFacts(args.profile, args.layout),
    `Record id: ${displayText(args.recordId, 20)}`,
    `The record as it is now (first ${Math.min(entries.length, MAX_FIELDS_PER_WRITE)} of ${entries.length} fields):`,
    ...entries.slice(0, MAX_FIELDS_PER_WRITE).map(([name, value]) => `${displayText(name, 128)}: ${displayText(valueText(value), 60)}`)
  ];
  return {
    title: 'An AI tool wants to DELETE a record',
    message: 'An AI tool wants to permanently delete a FileMaker record. You will be asked to type its id next.',
    detail: [...lines, ...modelNote(args.description)].join('\n'),
    confirmLabel: 'Continue'
  };
}

export function buildScriptConfirmation(args: {
  profile: ConnectionProfile;
  layout: string;
  script: string;
  parameter?: string;
  description?: string;
}): ConfirmSpec {
  if (args.parameter !== undefined && Array.from(args.parameter).length > MAX_SCRIPT_PARAMETER_CHARS) {
    throw new AiToolError('The script parameter is too long for the approval dialog to show in full, so it was refused.');
  }
  return {
    title: 'An AI tool wants to run a script',
    message: 'An AI tool wants to run a FileMaker script. A script name does not say what the script does.',
    detail: [
      ...hostFacts(args.profile, args.layout),
      `Script (runs as the account above): ${displayText(args.script, 64)}`,
      `Parameter: ${args.parameter === undefined ? '(none)' : displayText(args.parameter, MAX_SCRIPT_PARAMETER_CHARS)}`,
      ...modelNote(args.description)
    ].join('\n'),
    confirmLabel: 'Run Script'
  };
}

// -----------------------------------------------------------------------------------------
// Errors

function errorNote(error: unknown): string | undefined {
  return error instanceof Error ? error.message.slice(0, 200) : undefined;
}

/** Turns anything thrown into a message safe to show the model: no server address, user name, IP, path or secret. */
export function toModelError(error: unknown, profile: ConnectionProfile | undefined): Error {
  if (error instanceof AiToolError) {
    return error;
  }
  if (error instanceof AiInputError) {
    return new AiToolError(`Invalid input: ${error.message}`);
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AiToolError('The request was cancelled.', 'error');
  }

  let text: string;
  if (error instanceof FMClientError) {
    const code = error.code ? ` (FileMaker error ${error.code})` : error.status ? ` (HTTP ${error.status})` : '';
    text = `The FileMaker request failed${code}: ${error.message}`;
  } else if (error instanceof Error) {
    text = `The request failed: ${error.message}`;
  } else {
    text = 'The request failed.';
  }
  return new AiToolError(scrubGenericText(scrub(redactString(text), profile)).slice(0, 500), 'error');
}

/** Removes the server address, host and user name of a profile from text. */
export function scrub(text: string, profile: ConnectionProfile | undefined): string {
  if (!profile) {
    return text;
  }
  let result = text;
  const secrets = new Set<string>();
  try {
    const url = new URL(profile.serverUrl);
    secrets.add(profile.serverUrl);
    secrets.add(url.origin);
    secrets.add(url.host);
    secrets.add(url.hostname);
  } catch {
    secrets.add(profile.serverUrl);
  }
  if (profile.proxyEndpoint) {
    secrets.add(profile.proxyEndpoint);
  }
  if (profile.username && profile.username.length >= 3) {
    secrets.add(profile.username);
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length > 0) {
      result = result.split(secret).join('[server]');
    }
  }
  return result;
}
