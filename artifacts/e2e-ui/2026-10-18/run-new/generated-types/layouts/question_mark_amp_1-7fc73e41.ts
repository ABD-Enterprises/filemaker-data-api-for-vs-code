/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.714Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
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
