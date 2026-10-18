/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.616Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: Percent%20Layout
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface Percent20LayoutRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface Percent20LayoutFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const Percent20LayoutFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface Percent20LayoutRecord {
  recordId: string;
  modId?: string;
  fieldData: Percent20LayoutRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface Percent20LayoutFindRequest {
  query: Array<Partial<Percent20LayoutRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface Percent20LayoutFindResponse {
  data: Percent20LayoutRecord[];
  dataInfo?: Record<string, unknown>;
}
