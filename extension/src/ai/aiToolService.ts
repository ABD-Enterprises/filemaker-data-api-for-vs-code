import { fieldType, readOnlyFieldKind } from '../utils/fieldAccess';
import { EMPTY_FIND_ADVICE } from '../utils/findCriteria';
import type { EnterpriseFeatureId } from '../enterprise/roleGuard';
import type { ConnectionProfile, SchemaMetadataResult } from '../types/fm';
import type { AuditEntry } from './aiAudit';
import { explainFileMakerError } from './fileMakerErrors';
import { AiInputError, validateInput } from './aiSchema';
import type { AiSettings } from './aiSettings';
import { AI_TOOL_DEFINITIONS, findToolDefinition, type AiToolDefinition } from './aiToolDefinitions';
import { HiddenFields, displayText, safeNameOrUndefined } from './aiText';
import { accountName } from './aiConfirmations';
import { scrub } from './aiScrub';
import { AiToolError, errorNote, toModelError } from './tools/errors';
import { usableFieldName } from './tools/fields';
import { describeLayout, findRecords, getRecord, listLayouts, listScripts } from './tools/reads';
import { createRecord, deleteRecord, editRecord, runScript, type WriteToolRuntime } from './tools/writes';
import type { AiCallContext, AiStatus, AiToolDeps, ConfirmSpec, Control, Env, LayoutFields, Obj, Trace } from './tools/types';

export { AiToolError, toModelError } from './tools/errors';
export { MAX_RESULT_CHARS } from './tools/results';
export type { AiCallContext, AiStatus, AiToolDeps, ConfirmSpec } from './tools/types';
export { buildCreateConfirmation, buildDeleteConfirmation, buildEditConfirmation, buildScriptConfirmation } from './aiConfirmations';
export { scrub } from './aiScrub';

export const SESSION_RECORD_QUOTA = 500;
export const CALLS_PER_MINUTE = 30;
export const WRITES_PER_SESSION = 10;
export const WRITES_PER_MINUTE = 3;
const MINUTE_MS = 60_000;
/** A response body larger than this is refused by the client (not applied in proxy mode). */
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CONSENT_PROMPTS = 20;
const MAX_REFUSAL_AUDIT_PER_MINUTE = 10;

/**
 * The tool core (ADR-0004). It owns policy, consent, caps, redaction and audit. A transport
 * (VS Code language-model tools today, MCP later) only passes a tool name and input in and
 * the result out; it adds no policy of its own.
 */
export class AiToolService {
  private killed = false;
  /** Records read this session, including records reserved by calls still in flight. */
  private recordsUsed = 0;
  /** Bumped by `resetSession`; a settlement or approval from an older generation is ignored. */
  private generation = 0;
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
    this.generation += 1;
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
      if (definition.name === 'fm_find_records' && input && typeof input === 'object' &&
          Array.isArray((input as Obj).requests) && ((input as Obj).requests as unknown[]).length === 0) {
        throw new AiToolError(EMPTY_FIND_ADVICE);
      }
      validateInput(definition.inputSchema, input);
      context.signal?.throwIfAborted();
    } catch (error) {
      await this.audit(definition, profile, { client: context.client }, error instanceof AiToolError || error instanceof AiInputError ? 'refused' : 'error', null, errorNote(error));
      throw toModelError(error, profile);
    }

    const trace: Trace = { confirmed: null, client: context.client };
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

  /**
   * Why every tool is unavailable right now (settings, policy, trust, offline mode), or
   * undefined when none of those applies. The kill switch is not counted.
   */
  public unavailableReason(): string | undefined {
    return this.killed ? undefined : this.baseRefusal();
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
  private reserveRecords(wanted: number): { reserved: number; generation: number } {
    const remaining = SESSION_RECORD_QUOTA - this.recordsUsed;
    if (remaining <= 0) {
      throw new AiToolError(`The record quota for this session (${SESSION_RECORD_QUOTA}) is used up.`);
    }
    const reserved = Math.min(wanted, remaining);
    this.recordsUsed += reserved;
    return { reserved, generation: this.generation };
  }

  /**
   * Gives back the part of a reservation that was not used (all of it if the request failed).
   * A reservation made before a session reset belongs to the old session: its refund is
   * ignored, so the new session's counter cannot go negative.
   */
  private settleRecords(reservation: { reserved: number; generation: number }, returned: number): void {
    if (reservation.generation !== this.generation) {
      return;
    }
    this.recordsUsed -= Math.max(0, reservation.reserved - returned);
  }

  /** Runs `request` with `wanted` records reserved; refunds what it did not return. */
  private async withRecords<T>(wanted: number, request: (limit: number) => Promise<{ value: T; returned: number }>): Promise<T> {
    const reservation = this.reserveRecords(wanted);
    let returned = 0;
    try {
      const result = await request(reservation.reserved);
      returned = result.returned;
      return result.value;
    } finally {
      this.settleRecords(reservation, returned);
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

    const runtime: WriteToolRuntime = {
      deps: this.deps,
      useLayout: (env, layout) => this.useLayout(env, layout),
      layoutSchema: (env, layout) => this.layoutSchema(env, layout),
      layoutFields: (env, layout) => this.layoutFields(env, layout),
      withRecords: (wanted, request) => this.withRecords(wanted, request),
      quota: () => this.quota(),
      takeWriteSlot: () => this.takeWriteSlot(),
      dialog: (env, spec) => this.dialog(env, spec),
      recheck: (env) => this.recheck(env)
    };

    switch (definition.name) {
      case 'fm_list_layouts':
        return listLayouts(runtime, env);
      case 'fm_list_scripts':
        return listScripts(runtime, env);
      case 'fm_describe_layout':
        return describeLayout(runtime, env, input.layout as string);
      case 'fm_find_records':
        return findRecords(runtime, env, input);
      case 'fm_get_record':
        return getRecord(runtime, env, input.layout as string, input.recordId as string);
      case 'fm_edit_record':
        return editRecord(runtime, env, input);
      case 'fm_create_record':
        return createRecord(runtime, env, input);
      case 'fm_delete_record':
        return deleteRecord(runtime, env, input);
      case 'fm_run_script':
        return runScript(runtime, env, input);
      default:
        throw new AiToolError('Unknown tool.');
    }
  }

  // ---------------------------------------------------------------------------------------
  // Read quota

  private quota(): { used: number; limit: number } {
    return { used: this.recordsUsed, limit: SESSION_RECORD_QUOTA };
  }

  // ---------------------------------------------------------------------------------------
  // Write approval and policy re-check

  /**
   * After a dialog and before anything is sent: run every policy check again. The kill
   * switch, `enabled`, `allowWrites`, trust, offline mode or the connection may have changed
   * while the dialog was open, and a person's "yes" does not outlast that.
   */
  /** Opens a dialog; if the request is cancelled while it is open, tells the user it no longer counts. */
  private async dialog(env: Env, spec: ConfirmSpec): Promise<boolean> {
    const signal = env.control.signal;
    const onAbort = (): void => this.deps.ui.notifyCancelled?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.deps.ui.confirm(spec);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async recheck(env: Env): Promise<void> {
    try {
      const profile = await this.gate(env.definition);
      if (profile === undefined || profileFingerprint(profile) !== profileFingerprint(env.profile)) {
        throw new AiToolError('The connection for AI use changed.');
      }
      const settings = this.deps.settings();
      if (env.trace.layout !== undefined && !this.layoutAllowed(settings, env.profile.id, env.trace.layout)) {
        throw new AiToolError('The layout is no longer approved for AI reads.');
      }
      if (env.trace.script !== undefined && !(settings.scriptAllowlist[env.profile.id] ?? []).includes(env.trace.script)) {
        throw new AiToolError('The script is no longer on the allowlist.');
      }
      env.control.signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof AiToolError) {
        throw new AiToolError(`Policy changed while a dialog was open, so nothing was written: ${error.message}`);
      }
      throw error;
    }
  }

  /** A layout may be read if the user listed it for this connection or approved it this session. */
  private layoutAllowed(settings: AiSettings, profileId: string, layout: string): boolean {
    return (settings.readableLayouts[profileId] ?? []).includes(layout) || this.consented.has(`${profileId}\u0000${layout}`);
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
      const prompt: Promise<boolean> = this.deps.ui
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
        .finally(() => {
          if (this.consentInFlight.get(key) === prompt) {
            this.consentInFlight.delete(key);
          }
        });
      this.consentInFlight.set(key, prompt);
      pending = prompt;
    }

    const generation = this.generation;
    const allowed = await pending;
    env.control.signal?.throwIfAborted();
    // An answer given in a session that has since been reset belongs to that session.
    if (generation !== this.generation) {
      throw new AiToolError('The AI session was reset while a dialog was open. Try again.');
    }
    if (!allowed) {
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
    const readOnly = new Map<string, string>();
    const types = new Map<string, string>();
    for (const field of schema.fields) {
      const name = usableFieldName(field.name);
      if (name === undefined || env.hidden.isHidden(name)) {
        continue;
      }
      names.add(name);
      const type = fieldType(field.result ?? field.type);
      const kind = readOnlyFieldKind(field);
      if (kind) readOnly.set(name, kind);
      types.set(name, type);
      if (type === 'container') {
        containers.add(name);
      }
    }
    return { names, containers, readOnly, types };
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
      note: text,
      client: trace.client
    });
  }
}

/** What identifies the target of a write: a profile edited during a dialog is not the one approved. */
function profileFingerprint(profile: ConnectionProfile): string {
  return JSON.stringify([
    profile.id,
    profile.serverUrl,
    profile.database,
    profile.authMode,
    profile.username ?? null,
    profile.proxyEndpoint ?? null,
    profile.aiAccess ?? null
  ]);
}

function prune(times: number[], now: number): void {
  while (times.length > 0 && now - (times[0] as number) >= MINUTE_MS) {
    times.shift();
  }
}
