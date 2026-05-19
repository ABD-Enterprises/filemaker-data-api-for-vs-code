import { createWriteStream, type WriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

import { escapeCsvValue } from './exportCsv';

export interface CsvStreamWriterOptions {
  lineEnding?: '\n' | '\r\n';
  /**
   * Explicit column order. When provided, the header is written immediately and
   * subsequent rows are projected onto these columns (extra fields ignored).
   * When omitted, the column set is discovered from the first appended row,
   * then locked. Fields that appear only in later rows are silently dropped.
   *
   * FileMaker layouts have a fixed schema so discovery-from-first-row matches
   * the natural shape of the data.
   */
  columns?: string[];
}

export interface CsvStreamWriter {
  /** Append one record. The first call locks the column order if not preset. */
  append(record: Record<string, unknown>): Promise<void>;
  /** Flush and close. Safe to call multiple times. */
  close(): Promise<void>;
  /** Visible for tests / diagnostics. */
  getColumns(): string[];
}

/**
 * Streams CSV rows to disk so memory does not scale with the export size.
 *
 * Behavior:
 * - Writes the header on the first append() (or eagerly if columns provided).
 * - Locks the column set after the first row so column order is stable across
 *   the file. Fields appearing only in later rows are dropped (with a single
 *   diagnostic log via the optional onUnknownField callback).
 * - On close(), flushes pending writes and closes the underlying stream.
 */
export async function createCsvStreamWriter(
  path: string,
  options: CsvStreamWriterOptions = {}
): Promise<CsvStreamWriter> {
  await mkdir(dirname(path), { recursive: true });

  const lineEnding = options.lineEnding ?? '\n';
  const stream = createWriteStream(path, { encoding: 'utf8', flags: 'w' });

  let columns: string[] | undefined = options.columns ? [...options.columns] : undefined;
  let headerWritten = false;
  let closePromise: Promise<void> | undefined;

  const writeLine = (line: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      stream.write(line + lineEnding, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  const writeHeader = async (): Promise<void> => {
    if (headerWritten || !columns) return;
    await writeLine(columns.map(escapeCsvValue).join(','));
    headerWritten = true;
  };

  if (columns) {
    await writeHeader();
  }

  return {
    async append(record: Record<string, unknown>): Promise<void> {
      if (!columns) {
        columns = Object.keys(record);
        await writeHeader();
      }
      const cells = columns.map((col) => escapeCsvValue(record[col]));
      await writeLine(cells.join(','));
    },
    async close(): Promise<void> {
      // Memoize the close so repeated calls return the same settled promise
      // instead of trying to call stream.end() twice (which throws).
      if (!closePromise) {
        closePromise = closeStream(stream);
      }
      await closePromise;
    },
    getColumns(): string[] {
      return columns ? [...columns] : [];
    }
  };
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (stream.writableEnded || stream.closed) {
      stream.once('close', () => resolve());
      stream.once('error', reject);
      // If already closed (event fired before we attached), resolve immediately.
      if (stream.closed) {
        resolve();
      }
      return;
    }
    stream.end((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
