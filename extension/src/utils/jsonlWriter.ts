import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

export interface JsonlWriter {
  append(record: unknown): Promise<void>;
  close(): Promise<void>;
}

export async function createJsonlWriter(path: string): Promise<JsonlWriter> {
  await mkdir(dirname(path), { recursive: true });

  const stream = createWriteStream(path, {
    encoding: 'utf8',
    flags: 'w'
  });

  return {
    append: async (record: unknown) => {
      const line = serializeJsonLine(record);
      await writeLine(stream, line);
    },
    close: async () => {
      if (stream.closed) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

function serializeJsonLine(record: unknown): string {
  if (typeof record === 'string') {
    return `${JSON.stringify(record)}\n`;
  }

  return `${JSON.stringify(record)}\n`;
}

function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const canContinue = stream.write(line, (error: Error | null | undefined) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });

    if (canContinue) {
      return;
    }

    stream.once('drain', resolve);
  });
}
