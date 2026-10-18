/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.960Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: Back`tick
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface BackTickRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface BackTickFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const BackTickFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface BackTickRecord {
  recordId: string;
  modId?: string;
  fieldData: BackTickRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface BackTickFindRequest {
  query: Array<Partial<BackTickRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface BackTickFindResponse {
  data: BackTickRecord[];
  dataInfo?: Record<string, unknown>;
}
