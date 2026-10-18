/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.606Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
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
