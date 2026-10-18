/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.576Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: Dates
 * Metadata hash (sha256): fdd73ad812d831b876804c8da1175bc965e9219cc8e4e06c2bd3e208909e603a
 */

export interface DatesRawFieldData {
  "Label"?: string;
  "DateField"?: string;
  "TimestampField"?: string;
  "TimeField"?: string;
}

export interface DatesFieldData {
  label?: string; // Label
  dateField?: string; // DateField
  timestampField?: string; // TimestampField
  timeField?: string; // TimeField
}

export const DatesFieldNameMap = {
  "label": "Label",
  "dateField": "DateField",
  "timestampField": "TimestampField",
  "timeField": "TimeField",
} as const;

export interface DatesRecord {
  recordId: string;
  modId?: string;
  fieldData: DatesRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface DatesFindRequest {
  query: Array<Partial<DatesRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface DatesFindResponse {
  data: DatesRecord[];
  dataInfo?: Record<string, unknown>;
}
