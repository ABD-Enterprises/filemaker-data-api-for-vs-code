import { atomicExport } from './atomicExport';

export interface JsonlWriter {
  append(record: unknown): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export async function createJsonlWriter(path: string): Promise<JsonlWriter> {
  const file = await atomicExport(path);
  return {
    async append(record) { await file.write(`${JSON.stringify(record)}\n`); },
    close: () => file.close(),
    abort: () => file.abort()
  };
}
