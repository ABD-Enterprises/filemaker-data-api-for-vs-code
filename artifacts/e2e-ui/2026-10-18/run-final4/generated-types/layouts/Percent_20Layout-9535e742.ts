/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.927Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
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
