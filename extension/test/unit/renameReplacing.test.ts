import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
