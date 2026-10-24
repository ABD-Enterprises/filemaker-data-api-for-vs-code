import { getStringField, toRecord, validateEnvelope } from '../webviews/common/messageValidation';
import type { FindRecordsRequest } from '../types/fm';
import type { SnippetOperation, SnippetOperationKind } from './model';

const KINDS: readonly SnippetOperationKind[] = [
  'login',
  'find',
  'getRecord',
  'createRecord',
  'editRecord',
  'deleteRecord',
  'runScript',
  'listLayouts',
  'listScripts',
  'layoutMetadata',
  'uploadContainer'
];

const MAX_NAME = 1024;
const MAX_FIELDS = 500;

function objectField(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = toRecord(raw[key]);
  return value && Object.keys(value).length <= MAX_FIELDS ? value : undefined;
}

function objectList(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value) || value.length > MAX_FIELDS) {
    return undefined;
  }
  const items: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const record = toRecord(item);
    if (!record) {
      return undefined;
    }
    items.push(record);
  }
  return items;
}

/**
 * A find request given as text (the command palette) or an object: either the list of requests
 * (`[{ "Name": "x" }]`) or `{ query, sort, limit, offset }`. Returns undefined when it is neither.
 */
export function parseFindRequest(value: unknown): FindRecordsRequest | undefined {
  if (Array.isArray(value)) {
    const query = objectList(value);
    return query && query.length > 0 ? { query } : undefined;
  }
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  const query = objectList(record.query);
  if (!query || query.length === 0) {
    return undefined;
  }
  const request: FindRecordsRequest = { query };
  if (record.sort !== undefined) {
    const sort = objectList(record.sort);
    if (!sort) {
      return undefined;
    }
    request.sort = sort;
  }
  for (const key of ['limit', 'offset'] as const) {
    const number = record[key];
    if (number !== undefined) {
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
        return undefined;
      }
      request[key] = number;
    }
  }
  return request;
}

/** Validates an operation that arrives as data (a command argument); anything unexpected returns undefined. */
export function parseSnippetOperation(raw: unknown): SnippetOperation | undefined {
  if (!validateEnvelope(raw).ok) {
    return undefined;
  }
  const value = toRecord(raw);
  const kind = value ? getStringField(value, 'kind', { maxLength: 32 }) : undefined;
  if (!value || !kind || !KINDS.includes(kind as SnippetOperationKind)) {
    return undefined;
  }
  const text = (key: string): string | undefined => getStringField(value, key, { maxLength: MAX_NAME });

  switch (kind as SnippetOperationKind) {
    case 'login':
    case 'listLayouts':
    case 'listScripts':
      return { kind: kind as 'login' | 'listLayouts' | 'listScripts' };
    case 'find': {
      const layout = text('layout');
      const request = parseFindRequest(value.request);
      return layout && request ? { kind: 'find', layout, request } : undefined;
    }
    case 'getRecord':
    case 'deleteRecord': {
      const layout = text('layout');
      const recordId = text('recordId');
      return layout && recordId ? { kind: kind as 'getRecord' | 'deleteRecord', layout, recordId } : undefined;
    }
    case 'createRecord': {
      const layout = text('layout');
      const fieldData = objectField(value, 'fieldData');
      return layout && fieldData ? { kind: 'createRecord', layout, fieldData } : undefined;
    }
    case 'editRecord': {
      const layout = text('layout');
      const recordId = text('recordId');
      const fieldData = objectField(value, 'fieldData');
      return layout && recordId && fieldData ? { kind: 'editRecord', layout, recordId, fieldData } : undefined;
    }
    case 'runScript': {
      const layout = text('layout');
      const scriptName = text('scriptName');
      if (!layout || !scriptName) {
        return undefined;
      }
      const scriptParam = value.scriptParam === undefined ? undefined : getStringField(value, 'scriptParam');
      const recordId = value.recordId === undefined ? undefined : text('recordId');
      if ((value.scriptParam !== undefined && scriptParam === undefined) || (value.recordId !== undefined && recordId === undefined)) {
        return undefined;
      }
      return { kind: 'runScript', layout, scriptName, scriptParam, recordId };
    }
    case 'layoutMetadata': {
      const layout = text('layout');
      return layout ? { kind: 'layoutMetadata', layout } : undefined;
    }
    case 'uploadContainer': {
      const layout = text('layout');
      const recordId = text('recordId');
      const fieldName = text('fieldName');
      const fieldRepetition = value.fieldRepetition;
      if (
        !layout ||
        !recordId ||
        !fieldName ||
        (fieldRepetition !== undefined && (typeof fieldRepetition !== 'number' || !Number.isInteger(fieldRepetition)))
      ) {
        return undefined;
      }
      return {
        kind: 'uploadContainer',
        layout,
        recordId,
        fieldName,
        fieldRepetition: fieldRepetition as number | undefined,
        withModId: value.withModId === true
      };
    }
  }
}
