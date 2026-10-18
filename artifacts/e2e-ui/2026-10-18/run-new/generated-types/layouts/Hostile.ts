/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: 2026-10-18T18:54:50.592Z
 * Profile: Mock Quality (ed9ae535-801e-4d8b-b115-d6ae42eb40f6)
 * Layout: Hostile
 * Metadata hash (sha256): 4e3a13ea50608caeb71a992bc6adbbcc2d56a30c094e04f5a732d7f01ee8bd65
 */

export interface HostileRawFieldData {
  "RecordID"?: string;
  "modId"?: string;
  "recordId"?: string;
  "Customers::Name"?: string;
  "Name"?: string;
  "Orders::Total"?: string;
  "a..b"?: string;
  "../x"?: string;
  "a/b"?: string;
  "quote\"d"?: string;
  "back`tick"?: string;
  "CON"?: string;
  "NUL"?: string;
  "prn.txt"?: string;
  "__proto__"?: string;
  "constructor"?: string;
  "toString"?: string;
  "with space"?: string;
  "with\ttab"?: string;
  "<b>html</b>"?: string;
  "${x}"?: string;
  "x'; DROP TABLE y;--"?: string;
  "emoji🚀"?: string;
  "VeryLongXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"?: string;
  "Name(1)"?: string;
  "éé"?: string;
  "class"?: string;
  "default"?: string;
  "123"?: string;
  "ünïcödé"?: string;
}

export interface HostileFieldData {
  recordId?: string; // RecordID
  modId?: string; // modId
  recordId2?: string; // recordId
  customersName?: string; // Customers::Name
  name?: string; // Name
  ordersTotal?: string; // Orders::Total
  aB?: string; // a..b
  x?: string; // ../x
  aB2?: string; // a/b
  quoteD?: string; // quote\"d
  backTick?: string; // back`tick
  con?: string; // CON
  nul?: string; // NUL
  prnTxt?: string; // prn.txt
  proto?: string; // __proto__
  constructorField?: string; // constructor
  toString?: string; // toString
  withSpace?: string; // with space
  withTab?: string; // with\ttab
  bHtmlB?: string; // <b>html</b>
  x2?: string; // ${x}
  xDropTableY?: string; // x'; DROP TABLE y;--
  emoji?: string; // emoji🚀
  veryLongXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?: string; // VeryLongXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  name1?: string; // Name(1)
  eE?: string; // éé
  classField?: string; // class
  defaultField?: string; // default
  _123?: string; // 123
  nCD?: string; // ünïcödé
}

export const HostileFieldNameMap = {
  "recordId": "RecordID",
  "modId": "modId",
  "recordId2": "recordId",
  "customersName": "Customers::Name",
  "name": "Name",
  "ordersTotal": "Orders::Total",
  "aB": "a..b",
  "x": "../x",
  "aB2": "a/b",
  "quoteD": "quote\"d",
  "backTick": "back`tick",
  "con": "CON",
  "nul": "NUL",
  "prnTxt": "prn.txt",
  "proto": "__proto__",
  "constructorField": "constructor",
  "toString": "toString",
  "withSpace": "with space",
  "withTab": "with\ttab",
  "bHtmlB": "<b>html</b>",
  "x2": "${x}",
  "xDropTableY": "x'; DROP TABLE y;--",
  "emoji": "emoji🚀",
  "veryLongXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": "VeryLongXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "name1": "Name(1)",
  "eE": "éé",
  "classField": "class",
  "defaultField": "default",
  "_123": "123",
  "nCD": "ünïcödé",
} as const;

export interface HostileRecord {
  recordId: string;
  modId?: string;
  fieldData: HostileRawFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface HostileFindRequest {
  query: Array<Partial<HostileRawFieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface HostileFindResponse {
  data: HostileRecord[];
  dataInfo?: Record<string, unknown>;
}
