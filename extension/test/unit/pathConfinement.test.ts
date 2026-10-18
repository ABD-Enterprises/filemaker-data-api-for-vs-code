import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PathConfinementError,
  resolveConfinedFile,
  validateConfiguredPath
} from '../../src/utils/pathConfinement';

describe('validateConfiguredPath', () => {
  it('accepts plain relative and POSIX absolute paths', () => {
    expect(validateConfiguredPath(' docs/ai.md ')).toBe('docs/ai.md');
    expect(validateConfiguredPath('/home/me/ws/AGENTS.md')).toBe('/home/me/ws/AGENTS.md');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['NUL', 'a\0b.md'],
    ['parent segment', '../x.md'],
    ['nested parent', 'a/../../x.md'],
    ['backslash parent', 'a\\..\\..\\x.md'],
    ['git folder', '.git/hooks/pre-commit'],
    ['git folder, other case', 'a/.GIT/config'],
    ['drive-relative', 'D:folder\\x.md'],
    ['drive-relative bare', 'C:x.md'],
    ['colon in name', 'a:b.md'],
    ['second colon after drive', 'C:\\a:b'],
    ['newline', 'a\nb.md'],
    ['control character', 'a\u0007b.md'],
    ['line separator', 'a\u2028b.md'],
    ['bidi control', 'a\u202Eb.md'],
    ['Hangul filler (renders as blank)', 'a\u3164b.md'],
    ['Hangul choseong filler', 'a\u115Fb.md'],
    ['variation selector', 'a\uFE0Fb.md'],
    ['combining grapheme joiner', 'a\u034Fb.md'],
    ['halfwidth Hangul filler', 'a\uFFA0b.md'],
    ['trailing dot', 'docs/ai.'],
    ['trailing space in a folder', 'docs /ai.md'],
    ['short name', 'GIT~1/config'],
    ['short name file', 'docs/AGENTS~1.MD'],
    ['reserved device', 'docs/CON'],
    ['reserved device with extension', 'docs/nul.md'],
    ['reserved COM1', 'COM1.txt'],
    ['reserved LPT9 folder', 'lpt9/x.md']
  ])('rejects %s', (_label, value) => {
    expect(() => validateConfiguredPath(value, 'win32')).toThrow(PathConfinementError);
  });

  it('accepts a drive-absolute path on Windows only', () => {
    expect(validateConfiguredPath('C:\\work\\ai.md', 'win32')).toBe('C:\\work\\ai.md');
    expect(() => validateConfiguredPath('C:\\work\\ai.md', 'linux')).toThrow(PathConfinementError);
  });
});

describe('resolveConfinedFile', () => {
  let base: string;
  let workspace: string;
  let storage: string;
  let outside: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'fm-confine-')));
    workspace = join(base, 'workspace');
    storage = join(base, 'storage');
    outside = join(base, 'outside');
    await mkdir(workspace);
    await mkdir(storage);
    await mkdir(outside);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('resolves a relative path against the base and reports the root', async () => {
    const result = await resolveConfinedFile('docs/ai.md', workspace, [workspace, storage]);
    expect(result).toEqual({ path: join(workspace, 'docs', 'ai.md'), root: workspace, relativePath: 'docs/ai.md' });
  });

  it('accepts an absolute path inside either root', async () => {
    const inWorkspace = await resolveConfinedFile(join(workspace, 'AGENTS.md'), workspace, [workspace, storage]);
    expect(inWorkspace.root).toBe(workspace);
    const inStorage = await resolveConfinedFile(join(storage, 'a', 'b.md'), workspace, [workspace, storage]);
    expect(inStorage.root).toBe(storage);
  });

  it('rejects an absolute path outside every root', async () => {
    await expect(resolveConfinedFile(join(outside, 'x.md'), workspace, [workspace, storage])).rejects.toThrow(
      /outside the workspace/
    );
    await expect(resolveConfinedFile('/etc/passwd', workspace, [workspace, storage])).rejects.toThrow(
      PathConfinementError
    );
  });

  it('rejects ".." even when it would land back inside', async () => {
    await expect(resolveConfinedFile('a/../b.md', workspace, [workspace])).rejects.toThrow(/\.\./);
  });

  it('rejects a sibling folder whose name starts like the root', async () => {
    const sibling = `${workspace}-evil`;
    await mkdir(sibling);
    await expect(resolveConfinedFile(join(sibling, 'x.md'), workspace, [workspace])).rejects.toThrow(
      PathConfinementError
    );
  });

  it('rejects the root itself and an existing folder', async () => {
    await expect(resolveConfinedFile(workspace, workspace, [workspace])).rejects.toThrow(PathConfinementError);
    await mkdir(join(workspace, 'docs'));
    await expect(resolveConfinedFile('docs', workspace, [workspace])).rejects.toThrow(/folder/);
  });

  it('rejects a symlinked folder that leaves the workspace (real symlink)', async () => {
    await symlink(outside, join(workspace, 'link'), 'dir');
    await expect(resolveConfinedFile('link/ai.md', workspace, [workspace])).rejects.toThrow(/symbolic link/);
    await expect(resolveConfinedFile('link/deeper/new/ai.md', workspace, [workspace])).rejects.toThrow(
      /symbolic link/
    );
  });

  it('rejects a symlinked file that leaves the workspace', async () => {
    await writeFile(join(outside, 'victim.md'), 'x');
    await symlink(join(outside, 'victim.md'), join(workspace, 'AGENTS.md'));
    await expect(resolveConfinedFile('AGENTS.md', workspace, [workspace])).rejects.toThrow(/symbolic link/);
  });

  it('rejects a symlink even when it points back inside the workspace', async () => {
    await mkdir(join(workspace, 'real'));
    await symlink(join(workspace, 'real'), join(workspace, 'alias'), 'dir');
    await expect(resolveConfinedFile('alias/ai.md', workspace, [workspace])).rejects.toThrow(/symbolic link/);
  });

  it('allows the root itself to be a symlink (for example /tmp on macOS)', async () => {
    const linkedRoot = join(base, 'linked-workspace');
    await symlink(workspace, linkedRoot, 'dir');
    const result = await resolveConfinedFile('ai.md', linkedRoot, [linkedRoot]);
    expect(result.path).toBe(join(workspace, 'ai.md'));
  });

  it('rejects a path whose parent is a file', async () => {
    await writeFile(join(workspace, 'file.txt'), 'x');
    await expect(resolveConfinedFile('file.txt/ai.md', workspace, [workspace])).rejects.toThrow(/file, not a folder/);
  });

  it('allows paths that do not exist yet', async () => {
    const result = await resolveConfinedFile('new/dir/ai.md', workspace, [workspace]);
    expect(result.path).toBe(join(workspace, 'new', 'dir', 'ai.md'));
  });

  it('accepts a root that does not exist yet', async () => {
    const missing = join(base, 'not-created');
    const result = await resolveConfinedFile('ai.md', missing, [missing]);
    expect(result.path).toBe(join(missing, 'ai.md'));
  });
});
