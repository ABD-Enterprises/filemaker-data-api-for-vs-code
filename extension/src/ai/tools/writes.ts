import { isRecordModifiedConflict } from '../../services/errors';
import { redactString } from '../../utils/redact';
import { assertUsableUrlName } from '../../utils/urlSegment';
import { buildCreateConfirmation, buildDeleteConfirmation, buildEditConfirmation, buildScriptConfirmation, valueText } from '../aiConfirmations';
import { scrub } from '../aiScrub';
import { AiToolError } from './errors';
import { validateWriteFields } from './fields';
import type { ReadToolRuntime } from './reads';
import { shapeValues, valueForModel } from './results';
import type { AiToolDeps, ConfirmSpec, Env, Obj } from './types';

const MAX_SCRIPT_RESULT_CHARS = 10_000;

/** Writes use the service's original session caps, dialogs and post-dialog policy checks. */
export interface WriteToolRuntime extends ReadToolRuntime {
  deps: AiToolDeps;
  takeWriteSlot(): void;
  dialog(env: Env, spec: ConfirmSpec): Promise<boolean>;
  recheck(env: Env): Promise<void>;
}

export async function editRecord(runtime: WriteToolRuntime, env: Env, input: Obj): Promise<unknown> {
  const layout = input.layout as string;
  const recordId = input.recordId as string;
  await runtime.useLayout(env, layout);
  const fields = await runtime.layoutFields(env, layout);
  const requested = validateWriteFields(fields, input.fields as Record<string, string>);

  const record = await runtime.withRecords(1, async () => ({
    value: await runtime.deps.client.getRecord(env.profile, layout, recordId, env.control),
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
  runtime.takeWriteSlot();
  const confirmed = await runtime.dialog(env, confirmation);
  env.control.signal?.throwIfAborted();
  env.trace.confirmed = confirmed;
  if (!confirmed) {
    env.trace.declined = true;
    return { recordId, written: false, message: 'The user declined the change.' };
  }
  await runtime.recheck(env);

  const fieldData = Object.fromEntries(changes.map((change) => [change.name, change.newValue]));
  try {
    const result = await runtime.deps.client.editRecord(env.profile, layout, recordId, fieldData, env.control, {
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

export async function createRecord(runtime: WriteToolRuntime, env: Env, input: Obj): Promise<unknown> {
  const layout = input.layout as string;
  await runtime.useLayout(env, layout);
  const fields = await runtime.layoutFields(env, layout);
  const requested = validateWriteFields(fields, input.fields as Record<string, string>);
  if (input.dryRun === true) {
    return { dryRun: true, wouldCreate: requested.map(([name, value]) => ({ field: name, new: value })) };
  }

  const confirmation = buildCreateConfirmation({
    profile: env.profile,
    layout,
    values: requested,
    description: input.description as string | undefined
  });
  runtime.takeWriteSlot();
  const confirmed = await runtime.dialog(env, confirmation);
  env.control.signal?.throwIfAborted();
  env.trace.confirmed = confirmed;
  if (!confirmed) {
    env.trace.declined = true;
    return { written: false, message: 'The user declined creating the record.' };
  }
  await runtime.recheck(env);

  const result = await runtime.deps.client.createRecord(
    env.profile,
    layout,
    Object.fromEntries(requested),
    env.control
  );
  env.trace.recordIds = [result.recordId];
  return { written: true, recordId: result.recordId, modId: result.modId };
}

export async function deleteRecord(runtime: WriteToolRuntime, env: Env, input: Obj): Promise<unknown> {
  const layout = input.layout as string;
  const recordId = input.recordId as string;
  await runtime.useLayout(env, layout);
  const fields = await runtime.layoutFields(env, layout);
  const record = await runtime.withRecords(1, async () => ({
    value: await runtime.deps.client.getRecord(env.profile, layout, recordId, env.control),
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
  runtime.takeWriteSlot();
  const confirmed = await runtime.dialog(env, confirmation);
  env.control.signal?.throwIfAborted();
  if (!confirmed) {
    env.trace.confirmed = false;
    env.trace.declined = true;
    return { recordId, deleted: false, message: 'The user declined the deletion.' };
  }
  await runtime.recheck(env);

  const typed = await runtime.deps.ui.input({
    title: 'Delete record',
    prompt: `Type the record id ${recordId} to delete it. This cannot be undone. Dismiss to cancel.`
  });
  env.control.signal?.throwIfAborted();
  if (typed === undefined || typed.trim() !== recordId) {
    env.trace.confirmed = false;
    env.trace.declined = true;
    return { recordId, deleted: false, message: 'The deletion was not confirmed.' };
  }
  env.trace.confirmed = true;
  await runtime.recheck(env);

  // The record may have changed while the user decided; delete only what they saw.
  const fresh = await runtime.deps.client.getRecord(env.profile, layout, recordId, env.control);
  if (String(fresh.modId) !== String(record.modId)) {
    throw new AiToolError('The record changed while the deletion was being confirmed, so nothing was deleted. Read it again and retry.', 'error');
  }

  await runtime.deps.client.deleteRecord(env.profile, layout, recordId, env.control);
  return { recordId, deleted: true };
}

export async function runScript(runtime: WriteToolRuntime, env: Env, input: Obj): Promise<unknown> {
  const layout = input.layout as string;
  const script = input.script as string;
  env.trace.script = script;
  assertUsableUrlName(script, 'script', (message) => new AiToolError(message));
  assertUsableUrlName(layout, 'layout', (message) => new AiToolError(message));
  const allowlist = runtime.deps.settings().scriptAllowlist[env.profile.id] ?? [];
  if (!allowlist.includes(script)) {
    throw new AiToolError('That script is not on the user\'s allowlist for this connection (filemaker.ai.scriptAllowlist), so it cannot be run.');
  }
  await runtime.useLayout(env, layout);
  const scripts = await runtime.deps.client.listScripts(env.profile, env.control);
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
  runtime.takeWriteSlot();
  const confirmed = await runtime.dialog(env, confirmation);
  env.control.signal?.throwIfAborted();
  env.trace.confirmed = confirmed;
  if (!confirmed) {
    env.trace.declined = true;
    return { ran: false, message: 'The user declined running the script.' };
  }
  await runtime.recheck(env);

  const result = await runtime.deps.client.runScript(
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
