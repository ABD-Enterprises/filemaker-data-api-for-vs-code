/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.912Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: Customers 2019
 * Metadata hash (sha256): 5280583482a4761b235ffc0e300e6f64967b97e657a96f7ce0869f7e57c06257
 */

export interface Customers2019RawFieldData {
  "CustomerID"?: string;
  "FirstName"?: string;
  "LastName"?: string;
  "Joined"?: string;
}

export interface Customers2019FieldData {
  customerId?: string; // CustomerID
  firstName?: string; // FirstName
  lastName?: string; // LastName
  joined?: string; // Joined
}

export const Customers2019FieldNameMap = {
  "customerId": "CustomerID",
  "firstName": "FirstName",
  "lastName": "LastName",
  "joined": "Joined",
} as const;

export interface Customers2019Record {
  recordId: string;
  modId?: string;
  fieldData: Customers2019RawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface Customers2019FindRequest {
  query: Array<Partial<Customers2019RawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface Customers2019FindResponse {
  data: Customers2019Record[];
  dataInfo?: Record<string, unknown>;
}
