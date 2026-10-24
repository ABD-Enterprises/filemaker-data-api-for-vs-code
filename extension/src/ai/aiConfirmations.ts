import type { ConnectionProfile } from '../types/fm';
import { redactString } from '../utils/redact';
import { AiToolError } from './tools/errors';
import type { ConfirmSpec } from './tools/types';
import { MAX_DIALOG_DETAIL_CHARS, MAX_FIELDS_PER_WRITE, MAX_SCRIPT_PARAMETER_CHARS, MAX_WRITE_VALUE_CHARS } from './aiToolDefinitions';
import { displayText } from './aiText';

type Obj = Record<string, unknown>;

export function valueText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

export function accountName(profile: ConnectionProfile): string {
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

/** A dialog whose text is longer than the budget could be clipped, hiding later fields or the model's note. */
function assertDialogFits(detail: string): void {
  if (detail.length > MAX_DIALOG_DETAIL_CHARS) {
    throw new AiToolError(
      `This write would make an approval dialog longer than ${MAX_DIALOG_DETAIL_CHARS} characters (escaped characters take extra room), so it was refused. Send fewer or shorter values.`
    );
  }
}

/** Returns the text if it fits the dialog budget, else refuses. */
function fitted(detail: string): string {
  assertDialogFits(detail);
  return detail;
}

function assertShownInFull(count: number, values: string[]): void {
  if (count > MAX_FIELDS_PER_WRITE || values.some((value) => Array.from(value).length > MAX_WRITE_VALUE_CHARS)) {
    throw new AiToolError('This write is too large for the approval dialog to show in full, so it was refused.');
  }
}

const OLD_VALUE_SHOWN = 100;

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
    detail: fitted([...lines, ...modelNote(args.description)].join('\n')),
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
    detail: fitted([...lines, ...modelNote(args.description)].join('\n')),
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
  // The snapshot is only a reminder of what is deleted, so it shrinks to fit the budget
  // (fewer fields, announced in the heading) rather than blocking a delete.
  for (let shown = Math.min(entries.length, MAX_FIELDS_PER_WRITE); shown >= 0; shown -= 1) {
    const lines = [
      ...hostFacts(args.profile, args.layout),
      `Record id: ${displayText(args.recordId, 20)}`,
      `The record as it is now (first ${shown} of ${entries.length} fields):`,
      ...entries.slice(0, shown).map(([name, value]) => `${displayText(name, 128)}: ${displayText(valueText(value), 60)}`)
    ];
    const detail = [...lines, ...modelNote(args.description)].join('\n');
    if (detail.length <= MAX_DIALOG_DETAIL_CHARS || shown === 0) {
      return {
        title: 'An AI tool wants to DELETE a record',
        message: 'An AI tool wants to permanently delete a FileMaker record. You will be asked to type its id next.',
        detail: fitted(detail),
        confirmLabel: 'Continue'
      };
    }
  }
  throw new AiToolError('The approval dialog could not be built.');
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
    detail: fitted([
      ...hostFacts(args.profile, args.layout),
      `Script (runs as the account above): ${displayText(args.script, 64)}`,
      `Parameter: ${args.parameter === undefined ? '(none)' : displayText(args.parameter, MAX_SCRIPT_PARAMETER_CHARS)}`,
      ...modelNote(args.description)
    ].join('\n')),
    confirmLabel: 'Run Script'
  };
}
