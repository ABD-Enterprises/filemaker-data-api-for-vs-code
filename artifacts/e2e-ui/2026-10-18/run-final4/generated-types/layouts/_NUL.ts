/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.971Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: NUL
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface NulRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface NulFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const NulFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface NulRecord {
  recordId: string;
  modId?: string;
  fieldData: NulRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface NulFindRequest {
  query: Array<Partial<NulRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface NulFindResponse {
  data: NulRecord[];
  dataInfo?: Record<string, unknown>;
}
