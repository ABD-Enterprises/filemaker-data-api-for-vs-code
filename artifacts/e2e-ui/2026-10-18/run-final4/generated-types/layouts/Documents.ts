/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.881Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: Documents
 * Metadata hash (sha256): c94e439352d0de9216125f65d70b346368814d64decc02969a36d44f66d3aef3
 */

export interface DocumentsRawFieldData {
  "DocID"?: string;
  "Title"?: string;
  "File"?: string;
  "Thumb"?: string;
  "Kind"?: string;
}

export interface DocumentsFieldData {
  docId?: string; // DocID
  title?: string; // Title
  file?: string; // File
  thumb?: string; // Thumb
  kind?: string; // Kind
}

export const DocumentsFieldNameMap = {
  "docId": "DocID",
  "title": "Title",
  "file": "File",
  "thumb": "Thumb",
  "kind": "Kind",
} as const;

export interface DocumentsRecord {
  recordId: string;
  modId?: string;
  fieldData: DocumentsRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface DocumentsFindRequest {
  query: Array<Partial<DocumentsRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface DocumentsFindResponse {
  data: DocumentsRecord[];
  dataInfo?: Record<string, unknown>;
}
