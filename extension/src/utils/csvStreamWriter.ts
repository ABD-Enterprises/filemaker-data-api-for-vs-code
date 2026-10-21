import { atomicExport } from './atomicExport';
import { escapeCsvValue } from './exportCsv';

export type CsvRow = Record<string, unknown> | Map<string, unknown>;
export interface CsvStreamWriterOptions {
  lineEnding?: '\n' | '\r\n';
  columns?: string[];
  neutralizeFormulas?: boolean;
  excelCompatible?: boolean;
  /** Without metadata, discover the union of at most this many initial rows. */
  sampleSize?: number;
  onUnknownField?: (field: string) => void;
}
export interface CsvStreamWriter {
  append(record: CsvRow): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
  getColumns(): string[];
}

/** Bounded sampling when no schema is available; explicit columns preserve metadata order. */
export async function createCsvStreamWriter(path: string, options: CsvStreamWriterOptions = {}): Promise<CsvStreamWriter> {
  const file = await atomicExport(path);
  const lineEnding = options.lineEnding ?? '\n';
  let columns = options.columns ? [...options.columns] : undefined;
  const pending: Map<string, string>[] = [];
  let headerWritten = false;
  let closed = false;
  const keys = (row: CsvRow) => row instanceof Map ? [...row.keys()] : Object.keys(row);
  const writeRow = async (row: Map<string, string>) => {
    for (const key of keys(row)) if (!columns!.includes(key)) {
      options.onUnknownField?.(key);
    }
    await file.write(columns!.map((key) => row.get(key) ?? '').join(',') + lineEnding);
  };
  const flush = async () => {
    if (!columns) columns = [...new Set(pending.flatMap(keys))];
    if (!headerWritten) {
      await file.write((options.excelCompatible ? '\uFEFF' : '') + (columns.length ? columns.map((key) => escapeCsvValue(key, options)).join(',') + lineEnding : ''));
      headerWritten = true;
    }
    for (const row of pending) await writeRow(row);
    pending.length = 0;
  };
  return {
    async append(record) {
      const row = new Map(keys(record).map((key) => [key, escapeCsvValue(record instanceof Map ? record.get(key) : (Object.hasOwn(record, key) ? record[key] : undefined), options)]));
      if (!columns) {
        pending.push(row);
        if (pending.length >= (options.sampleSize ?? 100)) await flush();
      } else {
        await flush();
        await writeRow(row);
      }
    },
    async close() {
      if (closed) return;
      try { await flush(); await file.close(); closed = true; }
      catch (error) { await file.abort(); closed = true; throw error; }
    },
    async abort() { closed = true; await file.abort(); },
    getColumns() { return columns ? [...columns] : [...new Set(pending.flatMap(keys))]; }
  };
}
