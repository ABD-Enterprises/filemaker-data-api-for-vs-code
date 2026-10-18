import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { redactString } from '../utils/redact';
import { displayText, scrubGenericText } from './aiText';

export const AUDIT_MAX_BYTES = 256 * 1024;
const AUDIT_MAX_LINE = 2000;

export interface AuditEntry {
  tool: string;
  /** Connection display name. */
  connection: string;
  layout?: string;
  recordIds?: string[];
  outcome: 'ok' | 'refused' | 'declined' | 'error';
  /** Whether a person confirmed in a host dialog; null when no confirmation applies. */
  confirmed: boolean | null;
  /** Short note; model-supplied text is escaped and cut. */
  note?: string;
  /** The caller's own, unverified name for itself (for example from an MCP initialize). Logged, never trusted. */
  client?: string;
}

/**
 * One log line. Every string is escaped and cut with `displayText`, so text a model supplied
 * (a layout name, a description) cannot add a line, fake a field or hide text. Field values
 * are never logged.
 */
export function formatAuditLine(entry: AuditEntry, at: Date): string {
  const safe = (value: string | undefined, max: number): string | undefined =>
    value === undefined ? undefined : displayText(value, max);
  const line = JSON.stringify({
    at: at.toISOString(),
    tool: entry.tool,
    connection: safe(entry.connection, 80),
    client: safe(entry.client, 64),
    layout: safe(entry.layout, 80),
    recordIds: entry.recordIds?.slice(0, 50).map((id) => displayText(id, 20)),
    outcome: entry.outcome,
    confirmed: entry.confirmed,
    note: safe(entry.note === undefined ? undefined : scrubGenericText(redactString(entry.note)), 200)
  });
  return line.length > AUDIT_MAX_LINE ? `${line.slice(0, AUDIT_MAX_LINE)}…` : line;
}

const WRITE_TOOLS = new Set(['fm_edit_record', 'fm_create_record', 'fm_delete_record', 'fm_run_script']);

/** A line worth keeping when the file has to shrink: a write or script attempt. */
function isWriteLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { tool?: unknown };
    return typeof parsed.tool === 'string' && WRITE_TOOLS.has(parsed.tool);
  } catch {
    return false;
  }
}

/**
 * Append-only activity log in extension storage (never the workspace), size-capped. Every
 * operation goes through one promise queue, so two calls can neither interleave an append
 * with a trim nor race on the temporary file.
 */
export interface AuditIo {
  mkdir: typeof mkdir;
  appendFile: typeof appendFile;
  stat: typeof stat;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
}

const REAL_IO: AuditIo = { mkdir, appendFile, stat, readFile, writeFile, rename };

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly pathSource: string | (() => string),
    private readonly now: () => Date = () => new Date(),
    private readonly maxBytes = AUDIT_MAX_BYTES,
    /** For tests: lets them slow or watch file operations. */
    private readonly io: AuditIo = REAL_IO
  ) {}

  private get filePath(): string {
    return typeof this.pathSource === 'function' ? this.pathSource() : this.pathSource;
  }

  public record(entry: AuditEntry): Promise<void> {
    const line = `${formatAuditLine(entry, this.now())}\n`;
    const task = this.queue.then(async () => {
      try {
        await this.io.mkdir(dirname(this.filePath), { recursive: true });
        await this.io.appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
        await this.trim();
      } catch {
        // A full disk or a read-only folder must not turn a tool call into a failure.
      }
    });
    this.queue = task;
    return task;
  }

  public async read(): Promise<string> {
    await this.queue;
    try {
      return await this.io.readFile(this.filePath, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Shrinks an over-cap file to half the cap. Reads, refusals and other non-write lines go
   * first (oldest first), so a burst of noise cannot push write attempts out; if the write
   * lines alone are still too many, the oldest of those go too.
   */
  private async trim(): Promise<void> {
    const { size } = await this.io.stat(this.filePath);
    if (size <= this.maxBytes) {
      return;
    }

    const lines = (await this.io.readFile(this.filePath, 'utf8')).split('\n').filter((line) => line.length > 0);
    const target = this.maxBytes / 2;
    const bytes = (list: string[]): number => list.reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1, 0);
    const keep = lines.map(() => true);
    let total = bytes(lines);

    for (const writesOnly of [false, true]) {
      for (let index = 0; index < lines.length && total > target; index += 1) {
        if (keep[index] && (writesOnly || !isWriteLine(lines[index] as string))) {
          keep[index] = false;
          total -= Buffer.byteLength(lines[index] as string, 'utf8') + 1;
        }
      }
    }

    const temporary = `${this.filePath}.tmp`;
    await this.io.writeFile(temporary, `${lines.filter((_line, index) => keep[index]).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    await this.io.rename(temporary, this.filePath);
  }
}
