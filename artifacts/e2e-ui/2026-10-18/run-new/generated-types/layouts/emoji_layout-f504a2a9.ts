/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.698Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: emoji 🚀 layout
 * Metadata hash (sha256): 1e675c9833d253a2acd3a04d3b311d456556ea80c2269e59176765d8b3a331ed
 */

export interface EmojiLayoutRawFieldData {
  "Name"?: string;
  "Value"?: string;
}

export interface EmojiLayoutFieldData {
  name?: string; // Name
  value?: string; // Value
}

export const EmojiLayoutFieldNameMap = {
  "name": "Name",
  "value": "Value",
} as const;

export interface EmojiLayoutRecord {
  recordId: string;
  modId?: string;
  fieldData: EmojiLayoutRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface EmojiLayoutFindRequest {
  query: Array<Partial<EmojiLayoutRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface EmojiLayoutFindResponse {
  data: EmojiLayoutRecord[];
  dataInfo?: Record<string, unknown>;
}
