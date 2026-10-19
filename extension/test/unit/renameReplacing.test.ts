import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wraps the real rename so a test can make it fail the way Windows does.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
import * as fsp from 'fs/promises';
import type * as FsPromises from 'fs/promises';

import { renameReplacing } from '../../src/utils/renameReplacing';

describe('renameReplacing', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fm-rename-'));
  });
  afterEach(async () => {
    // A leftover read-only file would block the clean-up on Windows.
    for (const name of await readdir(dir).catch(() => [])) {
      await chmod(join(dir, name), 0o666).catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces an ordinary file', async () => {
    await writeFile(join(dir, 'a'), 'old');
    await writeFile(join(dir, 'b'), 'new');
    await renameReplacing(join(dir, 'b'), join(dir, 'a'));
    expect(await readFile(join(dir, 'a'), 'utf8')).toBe('new');
  });

  it('replaces a read-only file on every platform, and the replacement keeps the read-only mode it was given', async () => {
    const target = join(dir, 'locked');
    await writeFile(target, 'old');
    await chmod(target, 0o444);
    const source = join(dir, 'fresh');
    await writeFile(source, 'new');
    await chmod(source, 0o444);

    await renameReplacing(source, target);

    expect(await readFile(target, 'utf8')).toBe('new');
    expect((await stat(target)).mode & 0o222).toBe(0);
  });

  it('keeps the original error when the source is missing', async () => {
    await expect(renameReplacing(join(dir, 'nothing'), join(dir, 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not touch a folder at the target: that failure is not a read-only file', async () => {
    await mkdir(join(dir, 'folder'));
    await writeFile(join(dir, 'source'), 'x');
    await expect(renameReplacing(join(dir, 'source'), join(dir, 'folder'))).rejects.toBeDefined();
    expect((await stat(join(dir, 'folder'))).isDirectory()).toBe(true);
  });

  describe('the Windows retry branch (platform injected, rename made to fail with EPERM)', () => {
    const eperm = (): NodeJS.ErrnoException => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    const realRename = async (from: unknown, to: unknown): Promise<void> => {
      const actual = await vi.importActual<typeof FsPromises>('fs/promises');
      return actual.rename(String(from), String(to));
    };
    beforeEach(() => {
      vi.mocked(fsp.rename).mockClear();
    });
    afterEach(() => {
      vi.mocked(fsp.rename).mockReset();
      vi.mocked(fsp.rename).mockImplementation(realRename);
    });

    it('clears the read-only bit, retries once, and the replacement is in place', async () => {
      const target = join(dir, 'locked');
      const source = join(dir, 'fresh');
      await writeFile(target, 'old');
      await chmod(target, 0o444);
      await writeFile(source, 'new');
      const modesAtRename: number[] = [];
      vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
        modesAtRename.push((await stat(target)).mode & 0o200);
        if (modesAtRename.length === 1) throw eperm();
        return realRename(from, to);
      });

      await renameReplacing(source, target, 'win32');

      expect(fsp.rename).toHaveBeenCalledTimes(2);
      expect(modesAtRename[0]).toBe(0); // first attempt: still read-only
      expect(modesAtRename[1]).not.toBe(0); // retry: attribute cleared
      expect(await readFile(target, 'utf8')).toBe('new');
    });

    it('puts the read-only bit back and reports the second error when the retry fails too', async () => {
      const target = join(dir, 'locked');
      const source = join(dir, 'fresh');
      await writeFile(target, 'old');
      await chmod(target, 0o444);
      await writeFile(source, 'new');
      const second = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      vi.mocked(fsp.rename).mockRejectedValueOnce(eperm()).mockRejectedValueOnce(second);

      await expect(renameReplacing(source, target, 'win32')).rejects.toBe(second);

      expect((await stat(target)).mode & 0o222).toBe(0);
      expect(await readFile(target, 'utf8')).toBe('old');
    });

    it('keeps the original error for a writable target (a real permission problem) and does not retry', async () => {
      const target = join(dir, 'open');
      await writeFile(target, 'old');
      const first = eperm();
      vi.mocked(fsp.rename).mockRejectedValueOnce(first);
      await expect(renameReplacing(join(dir, 'x'), target, 'win32')).rejects.toBe(first);
      expect(fsp.rename).toHaveBeenCalledTimes(1);
    });

    it('does nothing special on other platforms', async () => {
      const target = join(dir, 'locked');
      await writeFile(target, 'old');
      await chmod(target, 0o444);
      const first = eperm();
      vi.mocked(fsp.rename).mockRejectedValueOnce(first);
      await expect(renameReplacing(join(dir, 'x'), target, 'linux')).rejects.toBe(first);
      expect(fsp.rename).toHaveBeenCalledTimes(1);
    });
  });
});
