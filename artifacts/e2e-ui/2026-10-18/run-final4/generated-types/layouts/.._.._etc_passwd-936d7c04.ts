/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.942Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: ../../etc/passwd
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface EtcPasswdRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface EtcPasswdFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const EtcPasswdFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface EtcPasswdRecord {
  recordId: string;
  modId?: string;
  fieldData: EtcPasswdRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface EtcPasswdFindRequest {
  query: Array<Partial<EtcPasswdRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface EtcPasswdFindResponse {
  data: EtcPasswdRecord[];
  dataInfo?: Record<string, unknown>;
}
