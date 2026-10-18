/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.667Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: Layout::With::Colons
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface LayoutWithColonsRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface LayoutWithColonsFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const LayoutWithColonsFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface LayoutWithColonsRecord {
  recordId: string;
  modId?: string;
  fieldData: LayoutWithColonsRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface LayoutWithColonsFindRequest {
  query: Array<Partial<LayoutWithColonsRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface LayoutWithColonsFindResponse {
  data: LayoutWithColonsRecord[];
  dataInfo?: Record<string, unknown>;
}
