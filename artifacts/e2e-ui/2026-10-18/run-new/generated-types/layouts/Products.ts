/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.566Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: Products
 * Metadata hash (sha256): aefae3e9c8992817be0bba3498400e30f25ad0ea010a60d6ebd5d95c6f396bc8
 */

export interface ProductsRawFieldData {
  "SKU"?: string;
  "Name"?: string;
  "Category"?: string;
  "Price"?: string;
  "InStock"?: string;
  "NewColumn"?: string;
}

export interface ProductsFieldData {
  sku?: string; // SKU
  name?: string; // Name
  category?: string; // Category
  price?: string; // Price
  inStock?: string; // InStock
  newColumn?: string; // NewColumn
}

export const ProductsFieldNameMap = {
  "sku": "SKU",
  "name": "Name",
  "category": "Category",
  "price": "Price",
  "inStock": "InStock",
  "newColumn": "NewColumn",
} as const;

export interface ProductsRecord {
  recordId: string;
  modId?: string;
  fieldData: ProductsRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface ProductsFindRequest {
  query: Array<Partial<ProductsRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface ProductsFindResponse {
  data: ProductsRecord[];
  dataInfo?: Record<string, unknown>;
}
