/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.897Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: UnicodeSamples
 * Metadata hash (sha256): a5aeb623385f6e84b08a396c8420f2b5ce80bc3ab8aad65e54c41d2bcaebb17a
 */

export interface UnicodeSamplesRawFieldData {
  "Label"?: string;
  "Category"?: string;
  "Value"?: string;
}

export interface UnicodeSamplesFieldData {
  label?: string; // Label
  category?: string; // Category
  value?: string; // Value
}

export const UnicodeSamplesFieldNameMap = {
  "label": "Label",
  "category": "Category",
  "value": "Value",
} as const;

export interface UnicodeSamplesRecord {
  recordId: string;
  modId?: string;
  fieldData: UnicodeSamplesRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface UnicodeSamplesFindRequest {
  query: Array<Partial<UnicodeSamplesRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface UnicodeSamplesFindResponse {
  data: UnicodeSamplesRecord[];
  dataInfo?: Record<string, unknown>;
}
