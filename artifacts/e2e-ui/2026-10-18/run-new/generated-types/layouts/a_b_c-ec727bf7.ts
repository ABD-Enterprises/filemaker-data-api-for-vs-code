/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.635Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: a/b\\c
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface ABCRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface ABCFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const ABCFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface ABCRecord {
  recordId: string;
  modId?: string;
  fieldData: ABCRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface ABCFindRequest {
  query: Array<Partial<ABCRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface ABCFindResponse {
  data: ABCRecord[];
  dataInfo?: Record<string, unknown>;
}
