/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.917Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: A/B
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface ABRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface ABFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const ABFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface ABRecord {
  recordId: string;
  modId?: string;
  fieldData: ABRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface ABFindRequest {
  query: Array<Partial<ABRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface ABFindResponse {
  data: ABRecord[];
  dataInfo?: Record<string, unknown>;
}
