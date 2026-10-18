/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.597Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: CustomersList
 * Metadata hash (sha256): b57e899f79539c339093a9dd9472033168c9beded3591758b4929caa3c3fdc54
 */

export interface CustomersListRawFieldData {
  "CustomerID"?: string;
  "FullName"?: string;
  "Email"?: string;
  "Status"?: string;
  "Region"?: string;
  "Balance"?: string;
}

export interface CustomersListFieldData {
  customerId?: string; // CustomerID
  fullName?: string; // FullName
  email?: string; // Email
  status?: string; // Status
  region?: string; // Region
  balance?: string; // Balance
}

export const CustomersListFieldNameMap = {
  "customerId": "CustomerID",
  "fullName": "FullName",
  "email": "Email",
  "status": "Status",
  "region": "Region",
  "balance": "Balance",
} as const;

export interface CustomersListRecord {
  recordId: string;
  modId?: string;
  fieldData: CustomersListRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface CustomersListFindRequest {
  query: Array<Partial<CustomersListRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface CustomersListFindResponse {
  data: CustomersListRecord[];
  dataInfo?: Record<string, unknown>;
}
