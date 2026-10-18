/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:40:00.021Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: question?mark&amp=1
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface QuestionMarkAmp1RawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface QuestionMarkAmp1FieldData {
  name?: string; // Name
  value?: string; // Value
}

export const QuestionMarkAmp1FieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface QuestionMarkAmp1Record {
  recordId: string;
  modId?: string;
  fieldData: QuestionMarkAmp1RawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface QuestionMarkAmp1FindRequest {
  query: Array<Partial<QuestionMarkAmp1RawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface QuestionMarkAmp1FindResponse {
  data: QuestionMarkAmp1Record[];
  dataInfo?: Record<string, unknown>;
}
