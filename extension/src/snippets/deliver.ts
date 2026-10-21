import * as vscode from 'vscode';

import type { ConnectionProfile } from '../types/fm';
import { getOptionalBooleanField, getStringField, toRecord } from '../webviews/common/messageValidation';
import { generateSnippet } from './index';
import { includeAuthByDefault } from './settings';
import {
  SNIPPET_FORMATS,
  isSnippetFormat,
  type SnippetFormat,
  type SnippetOperation
} from './model';

export type SnippetDestination = 'clipboard' | 'editor';

export interface SnippetDelivery {
  format: SnippetFormat;
  destination: SnippetDestination;
  includeAuthHeader: boolean;
}

/** Reads the `format`, `destination` and `includeAuthHeader` fields of a webview message; anything else is refused. */
export function parseSnippetDelivery(
  raw: Record<string, unknown>,
  fallbackFormat?: SnippetFormat
): SnippetDelivery | undefined {
  const rawFormat = getStringField(raw, 'format', { maxLength: 32 });
  const format = rawFormat === undefined ? fallbackFormat : isSnippetFormat(rawFormat) ? rawFormat : undefined;
  if (!format) {
    return undefined;
  }
  const destination = raw.destination;
  if (destination !== undefined && destination !== 'clipboard' && destination !== 'editor') {
    return undefined;
  }
  return {
    format,
    destination: destination ?? 'clipboard',
    includeAuthHeader: getOptionalBooleanField(raw, 'includeAuthHeader') === true
  };
}

/** Whether a webview message carries a delivery that is valid; used by panels that validate before reading the rest. */
export function hasValidDelivery(rawPayload: unknown, fallbackFormat?: SnippetFormat): boolean {
  const payload = toRecord(rawPayload);
  return payload !== undefined && parseSnippetDelivery(payload, fallbackFormat) !== undefined;
}

/**
 * Builds the request and puts it on the clipboard, or opens it in a new unsaved editor. Nothing is
 * written to a file: a `.http` file is saved by the user (Save As), never by the extension, so a
 * request never lands in the workspace unasked.
 */
export async function deliverSnippet(
  profile: ConnectionProfile,
  operation: SnippetOperation,
  delivery: SnippetDelivery
): Promise<void> {
  const text = generateSnippet(profile, operation, delivery.format, {
    includeAuthHeader: delivery.includeAuthHeader
  });
  const format = SNIPPET_FORMATS.find((candidate) => candidate.id === delivery.format);

  if (delivery.destination === 'editor') {
    const document = await vscode.workspace.openTextDocument({ language: format?.language ?? 'plaintext', content: text });
    await vscode.window.showTextDocument(document, { preview: false });
    return;
  }

  await vscode.env.clipboard.writeText(text);
  void vscode.window.showInformationMessage(`Copied ${format?.noun ?? 'request'} to clipboard.`);
}

export type RecordRequestKind = 'get' | 'edit' | 'delete';

export interface RecordRequestPayload {
  profileId: string;
  layout: string;
  recordId: string;
  kind: RecordRequestKind;
  delivery: SnippetDelivery;
  /** The editor's current form values (the Record Editor only). */
  draftFieldData?: Record<string, unknown>;
}

const MAX_NAME_LENGTH = 1024;
const MAX_DRAFT_FIELDS = 500;

/** Validates the `copyRecordRequest` message of the Record Viewer and Record Editor. */
export function parseRecordRequestPayload(raw: unknown): RecordRequestPayload | undefined {
  const payload = toRecord(raw);
  if (!payload) {
    return undefined;
  }
  const profileId = getStringField(payload, 'profileId', { maxLength: MAX_NAME_LENGTH });
  const layout = getStringField(payload, 'layout', { maxLength: MAX_NAME_LENGTH });
  const recordId = getStringField(payload, 'recordId', { maxLength: MAX_NAME_LENGTH });
  const kind = payload.operation;
  const delivery = parseSnippetDelivery(payload);
  if (
    !profileId ||
    !layout ||
    !recordId?.trim() ||
    (kind !== 'get' && kind !== 'edit' && kind !== 'delete') ||
    !delivery
  ) {
    return undefined;
  }

  let draftFieldData: Record<string, unknown> | undefined;
  if (payload.draftFieldData !== undefined) {
    const draft = toRecord(payload.draftFieldData);
    if (!draft || Object.keys(draft).length > MAX_DRAFT_FIELDS) {
      return undefined;
    }
    draftFieldData = draft;
  }

  // These panels have no "include auth" checkbox: they follow the setting.
  const includeAuthHeader =
    payload.includeAuthHeader === undefined
      ? includeAuthByDefault()
      : delivery.includeAuthHeader;

  return { profileId, layout, recordId, kind, delivery: { ...delivery, includeAuthHeader }, draftFieldData };
}

/**
 * The operation for "Copy request for this record". An edit sends the fields that changed; with no
 * change (or no form, as in the Record Viewer) it shows one field to fill in.
 */
export function recordOperation(
  kind: RecordRequestKind,
  layout: string,
  recordId: string,
  patch?: Record<string, unknown>
): SnippetOperation {
  switch (kind) {
    case 'get':
      return { kind: 'getRecord', layout, recordId };
    case 'delete':
      return { kind: 'deleteRecord', layout, recordId };
    case 'edit':
      return {
        kind: 'editRecord',
        layout,
        recordId,
        fieldData: patch && Object.keys(patch).length > 0 ? patch : { '<field name>': '<new value>' }
      };
  }
}
