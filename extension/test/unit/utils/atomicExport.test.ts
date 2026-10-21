import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicExport } from '../../../src/utils/atomicExport';

describe('atomicExport', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'atomic-export-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it.skipIf(process.platform === 'win32')('keeps new exports owner-only', async () => {
    const target = join(dir, 'new.csv');
    const file = await atomicExport(target);
    await file.write('complete');
    await file.close();
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['new.csv']);
  });

  it.skipIf(process.platform === 'win32').each([0o644, 0o444])('preserves replacement mode %s while keeping temporary data private', async (mode) => {
    const target = join(dir, 'existing.csv');
    await writeFile(target, 'old');
    await chmod(target, mode);
    const file = await atomicExport(target);
    await file.write('new');
    expect(await readFile(target, 'utf8')).toBe('old');
    const temporary = (await readdir(dir)).find((name) => name.endsWith('.tmp'))!;
    expect((await stat(join(dir, temporary))).mode & 0o777).toBe(0o600);
    await file.close();
    expect(await readFile(target, 'utf8')).toBe('new');
    expect((await stat(target)).mode & 0o777).toBe(mode);
  });

  it.skipIf(process.platform === 'win32')('matches writeFileAtomic by replacing the destination link without changing its referent', async () => {
    const referent = join(dir, 'original.csv');
    const target = join(dir, 'link.csv');
    await writeFile(referent, 'untouched');
    await chmod(referent, 0o644);
    await symlink(referent, target);
    const file = await atomicExport(target);
    await file.write('export');
    await file.close();
    expect(await readFile(referent, 'utf8')).toBe('untouched');
    expect(await readFile(target, 'utf8')).toBe('export');
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  it('cleans up temporary data when replacement fails', async () => {
    const target = join(dir, 'folder');
    await mkdir(target);
    const file = await atomicExport(target);
    await file.write('export');
    await expect(file.close()).rejects.toThrow();
    await file.abort();
    expect(await readdir(dir)).toEqual(['folder']);
    expect((await stat(target)).isDirectory()).toBe(true);
  });
});
