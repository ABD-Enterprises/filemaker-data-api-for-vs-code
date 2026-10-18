/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.988Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: ..%2f..%2fsecret
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface _2f2fsecretRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface _2f2fsecretFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const _2f2fsecretFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface _2f2fsecretRecord {
  recordId: string;
  modId?: string;
  fieldData: _2f2fsecretRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface _2f2fsecretFindRequest {
  query: Array<Partial<_2f2fsecretRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface _2f2fsecretFindResponse {
  data: _2f2fsecretRecord[];
  dataInfo?: Record<string, unknown>;
}
