/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.660Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
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
