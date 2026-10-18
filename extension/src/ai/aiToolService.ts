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
  MAX_RECORDS_PER_CALL,
  findToolDefinition,
  type AiToolDefinition
} from './aiToolDefinitions';
import {
  HIDDEN_MARKER,
  HiddenFields,
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
    listLayouts(profile: ConnectionProfile, control?: { signal?: AbortSignal }): Promise<string[]>;
    listScripts(profile: ConnectionProfile, control?: { signal?: AbortSignal }): Promise<string[]>;
    getRecord(profile: ConnectionProfile, layout: string, recordId: string, control?: { signal?: AbortSignal }): Promise<FileMakerRecord>;
    findRecords(profile: ConnectionProfile, layout: string, body: FindRecordsRequest, control?: { signal?: AbortSignal }): Promise<FindRecordsResult>;
    editRecord(
      profile: ConnectionProfile,
      layout: string,
      recordId: string,
      fieldData: Record<string, unknown>,
      control?: { signal?: AbortSignal },
      options?: { modId?: string }
    ): Promise<EditRecordResult>;
    createRecord(profile: ConnectionProfile, layout: string, fieldData: Record<string, unknown>, control?: { signal?: AbortSignal }): Promise<EditRecordResult>;
    deleteRecord(profile: ConnectionProfile, layout: string, recordId: string, control?: { signal?: AbortSignal }): Promise<EditRecordResult>;
    runScript(profile: ConnectionProfile, request: RunScriptRequest, control?: { signal?: AbortSignal }): Promise<RunScriptResult>;
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
  private recordsUsed = 0;
  private writesUsed = 0;
  private readonly callTimes: number[] = [];
  private readonly writeTimes: number[] = [];
  private readonly consented = new Set<string>();
  private readonly declined = new Set<string>();

  public constructor(private readonly deps: AiToolDeps) {}

  /** The kill switch. Switching back on starts a new session: counters and consent are cleared. */
  public setKilled(killed: boolean): void {
    if (this.killed && !killed) {
      this.resetSession();
    }
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
      throw new AiToolError(`Write cap reached: ${WRITES_PER_SESSION} write attempts per session. The user can switch the kill switch off and on to start a new session.`);
    }
    if (this.writeTimes.length >= WRITES_PER_MINUTE) {
      throw new AiToolError(`Write cap: at most ${WRITES_PER_MINUTE} write attempts per minute. Wait and try again.`);
    }
    this.writesUsed += 1;
    this.writeTimes.push(now);
  }

  private takeRecords(wanted: number): number {
    const remaining = SESSION_RECORD_QUOTA - this.recordsUsed;
    if (remaining <= 0) {
      throw new AiToolError(`The record quota for this session (${SESSION_RECORD_QUOTA}) is used up.`);
    }
    return Math.min(wanted, remaining);
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

    const control = { signal: context.signal };
    const hidden = new HiddenFields(this.deps.settings().hiddenFields);
    const env: Env = { profile, control, hidden, trace };

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
    const listed = layouts.slice(0, MAX_LAYOUTS_LISTED).map((name) => {
      const safe = safeNameOrUndefined(name);
      return safe === undefined ? { name: '[name omitted]', usable: false } : { name: safe, usable: true };
    });
    return { layouts: listed, count: layouts.length, truncated: layouts.length > MAX_LAYOUTS_LISTED };
  }

  private async listScripts(env: Env): Promise<unknown> {
    const scripts = await this.deps.client.listScripts(env.profile, env.control);
    const listed = scripts.slice(0, MAX_LAYOUTS_LISTED).map((name) => {
      const safe = safeNameOrUndefined(name);
      return safe === undefined ? { name: '[name omitted]', usable: false } : { name: safe, usable: true };
    });
    return { scripts: listed, count: scripts.length, truncated: scripts.length > MAX_LAYOUTS_LISTED };
  }

  private async describeLayout(env: Env, layout: string): Promise<unknown> {
    await this.useLayout(env, layout);
    const schema = await this.layoutSchema(env, layout);
    const fields = schema.fields
      .filter((field) => !env.hidden.isHidden(field.name))
      .map((field) => ({ name: exactFieldNameOrUndefined(field.name), field }))
      .filter((entry): entry is { name: string; field: (typeof schema.fields)[number] } => entry.name !== undefined)
      .map(({ name, field }) => ({
        name,
        type: typeof (field.result ?? field.type) === 'string' ? String(field.result ?? field.type).slice(0, 30) : undefined,
        repetitions: typeof field.repetitions === 'number' && field.repetitions > 1 ? field.repetitions : undefined
      }));
    return { layout, fields };
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
      const criteria: Obj = {};
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

    const limit = this.takeRecords((input.limit as number | undefined) ?? 20);
    const body: FindRecordsRequest = {
      query,
      ...(sort.length > 0 ? { sort } : {}),
      limit,
      ...(input.offset !== undefined ? { offset: input.offset as number } : {})
    };

    const result = await this.deps.client.findRecords(env.profile, layout, body, env.control);
    const shaped = this.shapeRecords(result.data.slice(0, limit), fields, env.hidden);
    this.recordsUsed += shaped.records.length;
    env.trace.recordIds = shaped.records.map((record) => String(record.recordId));
    const foundCount = result.dataInfo?.foundCount;
    return this.finish({
      layout,
      foundCount: typeof foundCount === 'number' ? foundCount : undefined,
      records: shaped.records,
      truncated: shaped.truncated || result.data.length > limit,
      quota: this.quota()
    });
  }

  private async getRecord(env: Env, layout: string, recordId: string): Promise<unknown> {
    await this.useLayout(env, layout);
    const fields = await this.layoutFields(env, layout);
    this.takeRecords(1);
    const record = await this.deps.client.getRecord(env.profile, layout, recordId, env.control);
    const shaped = this.shapeRecords([record], fields, env.hidden);
    this.recordsUsed += 1;
    env.trace.recordIds = [recordId];
    return this.finish({ layout, records: shaped.records, truncated: shaped.truncated, quota: this.quota() });
  }

  private quota(): { used: number; limit: number } {
    return { used: this.recordsUsed, limit: SESSION_RECORD_QUOTA };
  }

  /** Enforces the result size cap on the way out. */
  private finish(result: { records: unknown[]; truncated: boolean } & Obj): Obj {
    let text = JSON.stringify(result);
    while (text.length > MAX_RESULT_CHARS && result.records.length > 0) {
      result.records.pop();
      result.truncated = true;
      text = JSON.stringify(result);
    }
    return result;
  }

  private shapeRecords(
    records: FileMakerRecord[],
    fields: LayoutFields,
    hidden: HiddenFields
  ): { records: Obj[]; truncated: boolean } {
    const shaped = records.slice(0, MAX_RECORDS_PER_CALL).map((record) => {
      const out: Obj = {
        recordId: String(record.recordId),
        modId: record.modId === undefined ? undefined : String(record.modId),
        fields: shapeValues(record.fieldData ?? {}, hidden, fields.containers)
      };
      if (record.portalData && typeof record.portalData === 'object') {
        const portals: Obj = {};
        for (const [portalName, rows] of Object.entries(record.portalData)) {
          const name = exactFieldNameOrUndefined(portalName);
          if (name === undefined || hidden.isHidden(portalName) || !Array.isArray(rows)) {
            continue;
          }
          portals[name] = rows.slice(0, MAX_PORTAL_ROWS).map((row) => shapeValues(row, hidden, new Set()));
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

    this.takeRecords(1);
    const record = await this.deps.client.getRecord(env.profile, layout, recordId, env.control);
    this.recordsUsed += 1;
    env.trace.recordIds = [recordId];

    const changes = requested
      .map(([name, value]) => ({ name, oldValue: valueText(record.fieldData?.[name]), newValue: value }))
      .filter((change) => change.oldValue !== change.newValue);
    if (changes.length === 0) {
      return { recordId, changed: false, message: 'Every given value already matches the record. Nothing was written.' };
    }

    const preview = changes.map((change) => ({
      field: change.name,
      old: cut(redactString(change.oldValue)),
      new: cut(change.newValue)
    }));
    if (input.dryRun === true) {
      return { dryRun: true, recordId, changes: preview };
    }

    this.takeWriteSlot();
    const confirmation = buildEditConfirmation({
      profile: env.profile,
      layout,
      recordId,
      changes,
      description: input.description as string | undefined
    });
    const confirmed = await this.deps.ui.confirm(confirmation);
    env.trace.confirmed = confirmed;
    if (!confirmed) {
      env.trace.declined = true;
      return { recordId, written: false, message: 'The user declined the change.' };
    }

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
      return { dryRun: true, wouldCreate: requested.map(([name, value]) => ({ field: name, new: cut(value) })) };
    }

    this.takeWriteSlot();
    const confirmed = await this.deps.ui.confirm(
      buildCreateConfirmation({
        profile: env.profile,
        layout,
        values: requested,
        description: input.description as string | undefined
      })
    );
    env.trace.confirmed = confirmed;
    if (!confirmed) {
      env.trace.declined = true;
      return { written: false, message: 'The user declined creating the record.' };
    }

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
    this.takeRecords(1);
    const record = await this.deps.client.getRecord(env.profile, layout, recordId, env.control);
    this.recordsUsed += 1;
    env.trace.recordIds = [recordId];

    const snapshot = shapeValues(record.fieldData ?? {}, env.hidden, fields.containers);
    if (input.dryRun === true) {
      return { dryRun: true, recordId, wouldDelete: snapshot };
    }

    this.takeWriteSlot();
    const confirmed = await this.deps.ui.confirm(
      buildDeleteConfirmation({
        profile: env.profile,
        layout,
        recordId,
        snapshot,
        description: input.description as string | undefined
      })
    );
    if (!confirmed) {
      env.trace.confirmed = false;
      env.trace.declined = true;
      return { recordId, deleted: false, message: 'The user declined the deletion.' };
    }

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

    this.takeWriteSlot();
    const parameter = input.parameter as string | undefined;
    const confirmed = await this.deps.ui.confirm(
      buildScriptConfirmation({
        profile: env.profile,
        layout,
        script,
        parameter,
        description: input.description as string | undefined
      })
    );
    env.trace.confirmed = confirmed;
    if (!confirmed) {
      env.trace.declined = true;
      return { ran: false, message: 'The user declined running the script.' };
    }

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
          ? redactString(response.scriptResult).slice(0, MAX_SCRIPT_RESULT_CHARS)
          : undefined,
      scriptError: typeof response.scriptError === 'string' ? response.scriptError : undefined
    };
  }

  private validateWriteFields(fields: LayoutFields, given: Record<string, string>): Array<[string, string]> {
    const entries = Object.entries(given);
    if (entries.length === 0) {
      throw new AiToolError('At least one field is required.');
    }
    return entries.map(([name, value]) => {
      if (name.includes('::')) {
        throw new AiToolError('Related-record fields (Table::Field) cannot be written.');
      }
      const known = this.knownField(fields, name);
      if (fields.containers.has(known)) {
        throw new AiToolError('Container fields cannot be written by AI tools.');
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

    const allowed = await this.deps.ui.confirm({
      title: 'Allow an AI tool to read this layout?',
      message: `An AI tool asks to read layout ${displayText(layout, 64)} in connection ${displayText(env.profile.name, 64)}.`,
      detail: [
        'It will see field names and record values on this layout, including related and portal data reachable through it, up to the session limits.',
        'Anything it reads is sent to the AI model provider you chose.',
        `Account: ${displayText(accountName(env.profile), 64)}`
      ].join('\n'),
      confirmLabel: 'Allow for This Session'
    });
    if (!allowed) {
      this.declined.add(key);
      env.trace.declined = true;
      throw new AiToolError('The user did not allow reading this layout.');
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
      const name = exactFieldNameOrUndefined(field.name);
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
    await this.deps.audit.record({
      tool: definition.name,
      connection: profile?.name ?? '(none)',
      layout: trace.layout,
      recordIds: trace.recordIds,
      outcome,
      confirmed,
      note
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
  control: { signal?: AbortSignal };
  hidden: HiddenFields;
  trace: Trace;
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

/** Record values for the model: hidden fields removed, containers dropped, secrets redacted, long text cut. Names are not redacted. */
function shapeValues(data: Record<string, unknown>, hidden: HiddenFields, containers: Set<string>): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(data)) {
    const name = exactFieldNameOrUndefined(key);
    if (name === undefined || hidden.isHidden(key)) {
      continue;
    }
    if (containers.has(key)) {
      out[name] = '[container field omitted]';
      continue;
    }
    if (typeof value === 'string') {
      out[name] = cut(redactString(value));
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[name] = value;
    } else {
      out[name] = cut(redactString(JSON.stringify(value) ?? ''));
    }
  }
  return out;
}

function accountName(profile: ConnectionProfile): string {
  return profile.username ?? (profile.authMode === 'proxy' ? '(set by the proxy)' : '(unknown)');
}

// -----------------------------------------------------------------------------------------
// Confirmations. Host facts first; values escaped and cut; the model's own words last and labelled.

const MAX_DIFF_LINES = 15;

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

export function buildEditConfirmation(args: {
  profile: ConnectionProfile;
  layout: string;
  recordId: string;
  changes: Array<{ name: string; oldValue: string; newValue: string }>;
  description?: string;
}): ConfirmSpec {
  const lines = [
    ...hostFacts(args.profile, args.layout),
    `Record id: ${displayText(args.recordId, 20)}`,
    `Fields changed: ${args.changes.length}`,
    '',
    ...args.changes
      .slice(0, MAX_DIFF_LINES)
      .map((change) => `${displayText(change.name, 64)}: ${displayText(redactString(change.oldValue), 60)} -> ${displayText(change.newValue, 60)}`)
  ];
  if (args.changes.length > MAX_DIFF_LINES) {
    lines.push(`…and ${args.changes.length - MAX_DIFF_LINES} more fields`);
  }
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
  const lines = [
    ...hostFacts(args.profile, args.layout),
    `Fields set: ${args.values.length}`,
    '',
    ...args.values.slice(0, MAX_DIFF_LINES).map(([name, value]) => `${displayText(name, 64)}: ${displayText(value, 60)}`)
  ];
  if (args.values.length > MAX_DIFF_LINES) {
    lines.push(`…and ${args.values.length - MAX_DIFF_LINES} more fields`);
  }
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
    'The record as it is now:',
    ...entries.slice(0, MAX_DIFF_LINES).map(([name, value]) => `${displayText(name, 64)}: ${displayText(valueText(value), 60)}`)
  ];
  if (entries.length > MAX_DIFF_LINES) {
    lines.push(`…and ${entries.length - MAX_DIFF_LINES} more fields`);
  }
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
  return {
    title: 'An AI tool wants to run a script',
    message: 'An AI tool wants to run a FileMaker script. A script name does not say what the script does.',
    detail: [
      ...hostFacts(args.profile, args.layout),
      `Script (runs as the account above): ${displayText(args.script, 64)}`,
      `Parameter: ${args.parameter === undefined ? '(none)' : displayText(args.parameter, 200)}`,
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

/** Turns anything thrown into a message safe to show the model: no server address, user name or secret. */
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
  return new AiToolError(scrub(redactString(text), profile).slice(0, 500), 'error');
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
