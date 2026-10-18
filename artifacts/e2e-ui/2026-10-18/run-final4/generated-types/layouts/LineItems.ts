/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T17:39:59.875Z
 * Profile: Mock Quality (e5bf181e-1f51-488b-83cf-a7d8eaacae89)
 * Layout: LineItems
 * Metadata hash (sha256): ebe5d41cdc07e4a033545c76a8fcdd8bbbd15f2ae76965f096a08d007035ddcc
 */

export interface LineItemsRawFieldData {
  "LineID"?: string;
  "OrderID"?: string;
  "SKU"?: string;
  "Qty"?: string;
  "Price"?: string;
  "Description"?: string;
}

export interface LineItemsFieldData {
  lineId?: string; // LineID
  orderId?: string; // OrderID
  sku?: string; // SKU
  qty?: string; // Qty
  price?: string; // Price
  description?: string; // Description
}

export const LineItemsFieldNameMap = {
  "lineId": "LineID",
  "orderId": "OrderID",
  "sku": "SKU",
  "qty": "Qty",
  "price": "Price",
  "description": "Description",
} as const;

export interface LineItemsRecord {
  recordId: string;
  modId?: string;
  fieldData: LineItemsRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface LineItemsFindRequest {
  query: Array<Partial<LineItemsRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface LineItemsFindResponse {
  data: LineItemsRecord[];
  dataInfo?: Record<string, unknown>;
}
