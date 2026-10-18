/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.581Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
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
