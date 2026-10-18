/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.870Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: Orders
 * Metadata hash (sha256): f96c49cfaf3e8b91b9e1828a6ff8b7c3607033f02b23467a0cd95bb3d5d5402c
 */

export interface OrdersRawFieldData {
  "OrderID"?: string;
  "CustomerID"?: string;
  "OrderDate"?: string;
  "Total"?: string;
  "Status"?: string;
  "Notes"?: string;
  "LineCount"?: string;
}

export interface OrdersFieldData {
  orderId?: string; // OrderID
  customerId?: string; // CustomerID
  orderDate?: string; // OrderDate
  total?: string; // Total
  status?: string; // Status
  notes?: string; // Notes
  lineCount?: string; // LineCount
}

export const OrdersFieldNameMap = {
  "orderId": "OrderID",
  "customerId": "CustomerID",
  "orderDate": "OrderDate",
  "total": "Total",
  "status": "Status",
  "notes": "Notes",
  "lineCount": "LineCount",
} as const;

export interface OrdersRecord {
  recordId: string;
  modId?: string;
  fieldData: OrdersRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface OrdersFindRequest {
  query: Array<Partial<OrdersRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface OrdersFindResponse {
  data: OrdersRecord[];
  dataInfo?: Record<string, unknown>;
}
