/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.983Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: <script>alert(1)</script>
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface ScriptAlert1ScriptRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface ScriptAlert1ScriptFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const ScriptAlert1ScriptFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface ScriptAlert1ScriptRecord {
  recordId: string;
  modId?: string;
  fieldData: ScriptAlert1ScriptRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface ScriptAlert1ScriptFindRequest {
  query: Array<Partial<ScriptAlert1ScriptRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface ScriptAlert1ScriptFindResponse {
  data: ScriptAlert1ScriptRecord[];
  dataInfo?: Record<string, unknown>;
}
