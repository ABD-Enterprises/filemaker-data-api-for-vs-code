/**
 * Newline-delimited JSON framing, the same as MCP's stdio transport: one JSON-RPC message
 * per line, UTF-8, no embedded newlines. Used on the socket between the shim and the
 * extension host.
 */
export class FrameTooLargeError extends Error {
  public constructor(public readonly maxBytes: number) {
    super(`A message is larger than ${maxBytes} bytes.`);
    this.name = 'FrameTooLargeError';
  }
}

/** Splits a byte stream into lines, refusing any line (complete or still arriving) over `maxBytes`. */
export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);

  public constructor(private readonly maxBytes: number) {}

  /** Returns the complete lines in `data` (without the newline). Throws FrameTooLargeError. */
  public push(data: Buffer): string[] {
    this.pending = this.pending.length === 0 ? data : Buffer.concat([this.pending, data]);
    const lines: string[] = [];
    let start = 0;
    let index = this.pending.indexOf(0x0a, start);
    while (index !== -1) {
      if (index - start > this.maxBytes) {
        throw new FrameTooLargeError(this.maxBytes);
      }
      lines.push(this.pending.toString('utf8', start, index).replace(/\r$/, ''));
      start = index + 1;
      index = this.pending.indexOf(0x0a, start);
    }

    this.pending = start === 0 ? this.pending : this.pending.subarray(start);
    if (this.pending.length > this.maxBytes) {
      throw new FrameTooLargeError(this.maxBytes);
    }
    return lines.filter((line) => line.length > 0);
  }

  /** Bytes of a line that has started but not ended. */
  public pendingBytes(): number {
    return this.pending.length;
  }
}

export function encodeLine(message: unknown): string {
  // JSON.stringify writes no raw newline; U+2028/2029 are valid inside JSON strings.
  return `${JSON.stringify(message)}\n`;
}
