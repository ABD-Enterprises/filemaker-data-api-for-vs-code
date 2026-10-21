import type { FileMakerRecord } from '../types/fm';

export interface PortalInfo {
  name: string;
  records: Array<Record<string, unknown>>;
  fieldNames: string[];
  recordCount: number;
}

/**
 * Extract portal data from a FileMaker record into structured portal info objects.
 * Each key in `portalData` is a portal/table occurrence name.
 */
export function extractPortals(record: FileMakerRecord): PortalInfo[] {
  const portalData = record.portalData;

  if (!portalData || typeof portalData !== 'object') {
    return [];
  }

  const portals: PortalInfo[] = [];

  for (const [name, rows] of Object.entries(portalData)) {
    if (!Array.isArray(rows)) {
      continue;
    }

    const fieldNames = extractPortalFieldNames(rows);

    portals.push({
      name,
      records: rows,
      fieldNames,
      recordCount: rows.length
    });
  }

  return portals;
}

/**
 * Extract the unique field names from portal row data.
 * Filters out internal fields like `recordId` and `modId`.
 */
function extractPortalFieldNames(rows: Array<Record<string, unknown>>): string[] {
  const fieldSet = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key !== 'recordId' && key !== 'modId') {
        fieldSet.add(key);
      }
    }
  }

  return Array.from(fieldSet).sort();
}

/**
 * Extract portal metadata from layout metadata response.
 * The Data API returns portal metadata under `response.portalMetaData`.
 */
export function extractPortalMetadata(
  metadata: Record<string, unknown>
): Record<string, Array<{ name: string; type?: string; result?: string }>> {
  const raw = metadata.portalMetaData;

  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const result: Record<string, Array<{ name: string; type?: string; result?: string }>> = Object.create(null) as Record<string, Array<{ name: string; type?: string; result?: string }>>;

  for (const [portalName, fields] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(fields)) {
      continue;
    }

    result[portalName] = fields
      .filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object')
      .map((f) => ({
        name: typeof f.name === 'string' ? f.name : String(f.name ?? ''),
        type: typeof f.type === 'string' ? f.type : undefined,
        result: typeof f.result === 'string' ? f.result : undefined
      }));
  }

  return result;
}

/**
 * Build portal request parameters for the Data API find/get endpoints.
 * Supports limit and offset per portal.
 */
export function buildPortalParams(
  portals: Array<{ name: string; limit?: number; offset?: number }>
): Record<string, string | number> {
  const params: Record<string, string | number> = {};

  if (portals.length === 0) {
    return params;
  }

  // portal parameter format: portal=["Portal1","Portal2"]
  params.portal = JSON.stringify(portals.map((p) => p.name));

  for (const portal of portals) {
    if (portal.limit !== undefined) {
      params[`_limit.${portal.name}`] = portal.limit;
    }

    if (portal.offset !== undefined) {
      params[`_offset.${portal.name}`] = portal.offset;
    }
  }

  return params;
}
