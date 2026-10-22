import type { ConnectionProfile, FileMakerRecord } from '../../types/fm';
import { redactString } from '../../utils/redact';
import { MAX_RECORDS_PER_CALL } from '../aiToolDefinitions';
import { CONTAINER_MARKER, URL_OMITTED_MARKER, baseFieldName, exactFieldNameOrUndefined, safeNameOrUndefined } from '../aiText';
import { scrub } from '../aiScrub';
import type { Env, LayoutFields, Obj } from './types';

export const MAX_RESULT_CHARS = 200_000;
const MAX_VALUE_CHARS = 2000;
const MAX_PORTAL_ROWS = 20;
const MAX_LAYOUTS_LISTED = 200;

/** Enforces the result size cap on the way out. Each record is serialized once. */
export function finish(result: { records: unknown[]; truncated: boolean } & Obj): Obj {
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

export function shapeRecords(
  records: FileMakerRecord[],
  fields: LayoutFields,
  env: Env
): { records: Obj[]; truncated: boolean } {
  let truncated = records.length > MAX_RECORDS_PER_CALL;
  const shaped = records.slice(0, MAX_RECORDS_PER_CALL).map((record) => {
    const out: Obj = {
      recordId: String(record.recordId),
      modId: record.modId === undefined ? undefined : String(record.modId),
      fields: shapeValues(record.fieldData ?? {}, env, fields.containers)
    };
    if (record.portalData && typeof record.portalData === 'object') {
      const portals = Object.create(null) as Obj;
      const portalCounts = Object.create(null) as Obj;
      for (const [portalName, rows] of Object.entries(record.portalData)) {
        const name = exactFieldNameOrUndefined(portalName);
        if (name === undefined || env.hidden.isHidden(portalName) || !Array.isArray(rows)) {
          continue;
        }
        const info = record.portalDataInfo?.find((item) => item.portalObjectName === portalName || (!item.portalObjectName && item.table === portalName));
        const total = typeof info?.foundCount === 'number' ? info.foundCount : undefined;
        const returned = Math.min(rows.length, MAX_PORTAL_ROWS);
        if (rows.length > returned || (total !== undefined && total > returned)) truncated = true;
        portalCounts[name] = { returned, ...(total !== undefined ? { total } : {}) };
        portals[name] = rows.slice(0, MAX_PORTAL_ROWS).map((row) => shapeValues(row, env, new Set()));
      }
      out.portals = portals;
      out.portalCounts = portalCounts;
    }
    return out;
  });
  return { records: shaped, truncated };
}

function cut(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]` : value;
}

export function listNames(key: 'layouts' | 'scripts', names: string[]): Obj {
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
export function valueForModel(value: string, profile: ConnectionProfile): string {
  if (SERVER_URL_PATTERN.test(value)) {
    return URL_OMITTED_MARKER;
  }
  return cut(scrub(redactString(value), profile));
}

/** Record values for the model: hidden fields removed, containers dropped, URLs and secrets handled. */
export function shapeValues(data: Record<string, unknown>, env: Pick<Env, 'hidden' | 'profile'>, containers: Set<string>): Obj {
  // No prototype, so a field named "__proto__" is only a key.
  const out = Object.create(null) as Obj;
  for (const [key, value] of Object.entries(data)) {
    const name = exactFieldNameOrUndefined(key);
    if (name === undefined || env.hidden.isHidden(key)) {
      continue;
    }
    if (containers.has(baseFieldName(key))) {
      out[name] = CONTAINER_MARKER;
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
