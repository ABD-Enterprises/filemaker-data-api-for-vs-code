/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.682Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: ${process.env.HOME}
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface ProcessEnvHomeRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface ProcessEnvHomeFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const ProcessEnvHomeFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface ProcessEnvHomeRecord {
  recordId: string;
  modId?: string;
  fieldData: ProcessEnvHomeRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface ProcessEnvHomeFindRequest {
  query: Array<Partial<ProcessEnvHomeRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface ProcessEnvHomeFindResponse {
  data: ProcessEnvHomeRecord[];
  dataInfo?: Record<string, unknown>;
}
