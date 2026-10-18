/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.937Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: Question?Mark
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface QuestionMarkRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface QuestionMarkFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const QuestionMarkFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface QuestionMarkRecord {
  recordId: string;
  modId?: string;
  fieldData: QuestionMarkRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface QuestionMarkFindRequest {
  query: Array<Partial<QuestionMarkRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface QuestionMarkFindResponse {
  data: QuestionMarkRecord[];
  dataInfo?: Record<string, unknown>;
}
