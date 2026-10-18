/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.892Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: Numbers
 * Metadata hash (sha256): 8fb57bde47287d2a98af4d37bcd3281c24d571ba9b2bb426edbd86e52f62dc1a
 */

export interface NumbersRawFieldData {
  "Label"?: string;
  "NumberField"?: string;
  "TextNumber"?: string;
}

export interface NumbersFieldData {
  label?: string; // Label
  numberField?: string; // NumberField
  textNumber?: string; // TextNumber
}

export const NumbersFieldNameMap = {
  "label": "Label",
  "numberField": "NumberField",
  "textNumber": "TextNumber",
} as const;

export interface NumbersRecord {
  recordId: string;
  modId?: string;
  fieldData: NumbersRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface NumbersFindRequest {
  query: Array<Partial<NumbersRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface NumbersFindResponse {
  data: NumbersRecord[];
  dataInfo?: Record<string, unknown>;
}
