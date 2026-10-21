import { randomUUID } from 'crypto';
import { mkdir, open, rename, rm } from 'fs/promises';
import { dirname, join, basename } from 'path';

/** Publish only a complete export. Temporary and published files are owner-only. */
export async function atomicExport(path: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  let finished = false;
  return {
    async write(text: string): Promise<void> { await file.writeFile(text, 'utf8'); },
    async close(): Promise<void> {
      if (finished) return;
      try {
        await file.close();
        await rename(temporary, path);
        finished = true;
      } catch (error) {
        await file.close().catch(() => undefined);
        await rm(temporary, { force: true });
        finished = true;
        throw error;
      }
    },
    async abort(): Promise<void> {
      if (finished) return;
      finished = true;
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  };
}
