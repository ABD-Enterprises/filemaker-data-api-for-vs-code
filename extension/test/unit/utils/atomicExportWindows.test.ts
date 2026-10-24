import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import type * as FsPromises from 'fs/promises';
import * as replacing from '../../../src/utils/renameReplacing';
import { atomicExport } from '../../../src/utils/atomicExport';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

it('retries a Windows read-only replacement through renameReplacing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-windows-'));
  const target = join(dir, 'readonly.csv');
  const actual = replacing.renameReplacing;
  const replacement = vi.spyOn(replacing, 'renameReplacing').mockImplementation((source, destination) => actual(source, destination, 'win32'));
  try {
    await writeFile(target, 'original');
    await chmod(target, 0o444);
    const file = await atomicExport(target);
    await file.write('complete');
    vi.mocked(fsp.rename).mockRejectedValueOnce(Object.assign(new Error('read-only target'), { code: 'EPERM' }));
    await file.close();
    expect(await readFile(target, 'utf8')).toBe('complete');
    expect((await stat(target)).mode & 0o222).toBe(0);
    expect(await readdir(dir)).toEqual(['readonly.csv']);
  } finally {
    replacement.mockRestore();
    vi.mocked(fsp.rename).mockReset();
    await chmod(target, 0o666).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
