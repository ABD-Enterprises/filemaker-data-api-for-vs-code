import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { displayText } from './aiText';

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
    layout: safe(entry.layout, 80),
    recordIds: entry.recordIds?.slice(0, 50).map((id) => displayText(id, 20)),
    outcome: entry.outcome,
    confirmed: entry.confirmed,
    note: safe(entry.note, 200)
  });
  return line.length > AUDIT_MAX_LINE ? `${line.slice(0, AUDIT_MAX_LINE)}…` : line;
}

/** Append-only activity log in extension storage (never the workspace), size-capped. */
export class AuditLog {
  public constructor(
    private readonly pathSource: string | (() => string),
    private readonly now: () => Date = () => new Date(),
    private readonly maxBytes = AUDIT_MAX_BYTES
  ) {}

  private get filePath(): string {
    return typeof this.pathSource === 'function' ? this.pathSource() : this.pathSource;
  }

  public async record(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${formatAuditLine(entry, this.now())}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.trim();
    } catch {
      // A full disk or a read-only folder must not turn a tool call into a failure.
    }
  }

  public async read(): Promise<string> {
    try {
      return await readFile(this.filePath, 'utf8');
    } catch {
      return '';
    }
  }

  /** Keeps the newest lines when the file is over the cap. */
  private async trim(): Promise<void> {
    const { size } = await stat(this.filePath);
    if (size <= this.maxBytes) {
      return;
    }

    const text = await readFile(this.filePath, 'utf8');
    const lines = text.split('\n').filter((line) => line.length > 0);
    let kept = lines.slice(Math.floor(lines.length / 2));
    while (kept.length > 1 && Buffer.byteLength(kept.join('\n'), 'utf8') > this.maxBytes / 2) {
      kept = kept.slice(1);
    }
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${kept.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
