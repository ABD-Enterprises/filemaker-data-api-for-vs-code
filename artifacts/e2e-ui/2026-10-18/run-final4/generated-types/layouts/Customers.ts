/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.861Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: Customers
 * Metadata hash (sha256): 23e121bc224973ee2caf3c51053125a4e72caa1a43bd663a1416e6b41a74dd40
 */

export interface CustomersRawFieldData {
  "CustomerID"?: string;
  "FirstName"?: string;
  "LastName"?: string;
  "FullName"?: string;
  "Email"?: string;
  "Phone"?: string;
  "Phones"?: string;
  "Company"?: string;
  "Status"?: string;
  "Region"?: string;
  "Balance"?: string;
  "BalanceText"?: string;
  "Rating"?: string;
  "Joined"?: string;
  "LastContact"?: string;
  "BirthDate"?: string;
  "Notes"?: string;
  "Bio"?: string;
  "Avatar"?: string;
  "Brochure"?: string;
  "OrderCount"?: string;
  "TotalOrdered"?: string;
  "gFilter"?: string;
  "SSN"?: string;
  "Password"?: string;
  "Token"?: string;
  "InternalUrl"?: string;
}

export interface CustomersFieldData {
  customerId?: string; // CustomerID
  firstName?: string; // FirstName
  lastName?: string; // LastName
  fullName?: string; // FullName
  email?: string; // Email
  phone?: string; // Phone
  phones?: string; // Phones
  company?: string; // Company
  status?: string; // Status
  region?: string; // Region
  balance?: string; // Balance
  balanceText?: string; // BalanceText
  rating?: string; // Rating
  joined?: string; // Joined
  lastContact?: string; // LastContact
  birthDate?: string; // BirthDate
  notes?: string; // Notes
  bio?: string; // Bio
  avatar?: string; // Avatar
  brochure?: string; // Brochure
  orderCount?: string; // OrderCount
  totalOrdered?: string; // TotalOrdered
  gFilter?: string; // gFilter
  ssn?: string; // SSN
  password?: string; // Password
  token?: string; // Token
  internalUrl?: string; // InternalUrl
}

export const CustomersFieldNameMap = {
  "customerId": "CustomerID",
  "firstName": "FirstName",
  "lastName": "LastName",
  "fullName": "FullName",
  "email": "Email",
  "phone": "Phone",
  "phones": "Phones",
  "company": "Company",
  "status": "Status",
  "region": "Region",
  "balance": "Balance",
  "balanceText": "BalanceText",
  "rating": "Rating",
  "joined": "Joined",
  "lastContact": "LastContact",
  "birthDate": "BirthDate",
  "notes": "Notes",
  "bio": "Bio",
  "avatar": "Avatar",
  "brochure": "Brochure",
  "orderCount": "OrderCount",
  "totalOrdered": "TotalOrdered",
  "gFilter": "gFilter",
  "ssn": "SSN",
  "password": "Password",
  "token": "Token",
  "internalUrl": "InternalUrl",
} as const;

export interface CustomersRecord {
  recordId: string;
  modId?: string;
  fieldData: CustomersRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface CustomersFindRequest {
  query: Array<Partial<CustomersRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface CustomersFindResponse {
  data: CustomersRecord[];
  dataInfo?: Record<string, unknown>;
}
