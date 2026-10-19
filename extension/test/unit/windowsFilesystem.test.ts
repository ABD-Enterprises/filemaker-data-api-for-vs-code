import { execFile } from 'child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISCOVERY_VERSION, assertOwnerOnly, ensureOwnerOnlyDirectory, scanDiscovery, selectWindow, writeDiscovery } from '../../src/ai/mcp/discovery';
import { writeFileAtomic } from '../../src/services/aiContextWriter';
import { installShim } from '../../src/ai/mcp/mcpConfig';
import { newToken } from '../../src/ai/mcp/auth';
import { FmWebRuntimeGenerator, writeManagedFile } from '../../src/services/fmWebRuntimeGenerator';
import { resolveConfinedFile } from '../../src/utils/pathConfinement';

const windows = process.platform === 'win32';
const extensionDir = path.resolve(__dirname, '../..');

/** A directory junction: the link type a normal Windows user can create (a directory symlink needs a privilege). */
const junction = (target: string, link: string): Promise<void> => symlink(target, link, 'junction');

function icacls(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('icacls', args, { windowsHide: true, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

// What Windows does with links and permissions differs from Unix, and a macOS or Linux run cannot
// show it: junctions exist only on Windows, and "owner-only" there is an ACL, not a mode (every
// file reports mode 0666). These run on a real Windows host in CI.
describe.skipIf(!windows)('links and access rights on Windows', () => {
  let dir: string;
  let outside: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fm-win-'));
    outside = path.join(dir, 'outside');
    await mkdir(outside);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('junctions are links, and are refused like symbolic links', () => {
    it('lstat reports a junction as a symbolic link (which every refusal below relies on), live or dangling', async () => {
      const live = path.join(dir, 'live');
      await junction(outside, live);
      expect((await lstat(live)).isSymbolicLink()).toBe(true);

      const gone = path.join(dir, 'gone-target');
      await mkdir(gone);
      const dangling = path.join(dir, 'dangling');
      await junction(gone, dangling);
      await rm(gone, { recursive: true });
      expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
    });

    it('the discovery folder checks refuse a junction in place of the folder', async () => {
      const link = path.join(dir, 'ai-mcp');
      await junction(outside, link);
      await expect(assertOwnerOnly(link, 'directory')).rejects.toThrow(/symbolic link/);
      await expect(ensureOwnerOnlyDirectory(link)).rejects.toThrow(/symbolic link/);
      await expect(scanDiscovery(link)).rejects.toThrow(/symbolic link/);
      await expect(writeDiscovery(link, 'a.json', {
        version: DISCOVERY_VERSION,
        socketPath: `\\\\.\\pipe\\fm-ai-${'a'.repeat(32)}`,
        pid: process.pid,
        startTime: 'x',
        token: newToken(),
        workspaceFolders: [],
        label: 'l',
        created: 'x'
      })).rejects.toThrow(/symbolic link/);
      // Nothing was written through it.
      expect(await readdir(outside)).toEqual([]);
    });

    it('a discovery file that is a junction is refused as not a file', async () => {
      const directory = path.join(dir, 'ai-mcp');
      await ensureOwnerOnlyDirectory(directory);
      await junction(outside, path.join(directory, 'evil.json'));
      const scan = await scanDiscovery(directory);
      expect(scan.live).toEqual([]);
      expect(scan.unsafe.map((entry) => path.basename(entry.file))).toEqual(['evil.json']);
    });

    it('the shim is not installed through a junction in place of its folder', async () => {
      const storage = path.join(dir, 'storage');
      await mkdir(storage);
      await junction(outside, path.join(storage, 'ai-mcp-shim'));
      const source = path.join(dir, 'aiMcpShim.js');
      await writeFile(source, 'shim-content');
      expect(await installShim(source, storage)).toEqual({ path: source, stable: false });
      expect(await readdir(outside)).toEqual([]);
    });

    it('path confinement refuses a junction that leaves the workspace, one that points back in, and a dangling one', async () => {
      const workspace = path.join(dir, 'workspace');
      await mkdir(path.join(workspace, 'real'), { recursive: true });
      await junction(outside, path.join(workspace, 'out'));
      await junction(path.join(workspace, 'real'), path.join(workspace, 'alias'));
      const gone = path.join(dir, 'gone');
      await mkdir(gone);
      await junction(gone, path.join(workspace, 'dangling'));
      await rm(gone, { recursive: true });

      for (const candidate of ['out/ai.md', 'out/deeper/new/ai.md', 'alias/ai.md', 'dangling/ai.md']) {
        await expect(resolveConfinedFile(candidate, workspace, [workspace]), candidate).rejects.toThrow(/symbolic link/);
      }
    });

    it('a workspace root that is itself a junction is allowed, and the real folder is the base', async () => {
      const workspace = path.join(dir, 'workspace');
      await mkdir(workspace);
      const linkedRoot = path.join(dir, 'linked-workspace');
      await junction(workspace, linkedRoot);
      const result = await resolveConfinedFile('ai.md', linkedRoot, [linkedRoot]);
      expect(result.path.toLowerCase()).toBe(path.join(await realpath(workspace), 'ai.md').toLowerCase());
      expect(result.path.toLowerCase()).not.toContain('linked-workspace');
    });

    it('the generated runtime is not written through a folder that is a junction', async () => {
      const generated = path.join(dir, 'generated');
      await mkdir(path.join(generated, 'runtime-next'), { recursive: true });
      await junction(outside, path.join(generated, 'runtime-next', 'lib'));
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const generator = new FmWebRuntimeGenerator(
        { extensionUri: { fsPath: extensionDir } } as never,
        { isWorkspaceTrusted: () => true, getGeneratedDirPath: () => generated, ensureProjectInitialized: async () => undefined } as never,
        logger
      );
      await expect(generator.generateRuntimeAppTemplate()).rejects.toThrow(/link to a folder outside/);
      expect(await readdir(outside)).toEqual([]);
    });
  });

  describe('read-only files', () => {
    // Windows will not rename a file over a read-only one, where Unix lets the folder decide, so a
    // managed or user file marked read-only (by a version-control tool, or by hand) must still be
    // updatable, and must stay read-only afterwards.
    it.each([
      ['writeManagedFile', (target: string) => writeManagedFile(target, 'new content')],
      ['writeFileAtomic', (target: string) => writeFileAtomic(target, 'new content')]
    ])('%s replaces a read-only file and keeps it read-only', async (_name, write) => {
      const target = path.join(dir, 'locked.txt');
      await writeFile(target, 'old content');
      await chmod(target, 0o444);
      expect((await stat(target)).mode & 0o222).toBe(0);

      await write(target);

      await chmod(target, 0o666); // so the read and the clean-up cannot be blocked either way
      expect(await readFile(target, 'utf8')).toBe('new content');
    });

    it('leaves no temporary file behind', async () => {
      const target = path.join(dir, 'locked.txt');
      await writeFile(target, 'old content');
      await chmod(target, 0o444);
      await writeManagedFile(target, 'x').catch(() => undefined);
      await chmod(target, 0o666);
      expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('folder names are matched without regard to case', () => {
    it('selects the window for a folder named with another drive-letter case', () => {
      const live = [{ file: 'a.json', record: { version: DISCOVERY_VERSION, socketPath: `\\\\.\\pipe\\fm-ai-${'c'.repeat(32)}`, pid: 1, startTime: 'x', token: 'a'.repeat(64), workspaceFolders: ['c:\\work\\alpha'], label: 'alpha window', created: 'x' } }] as never;
      expect(selectWindow(live, 'C:\\Work\\Alpha', []).ok).toBe(true);
      expect(selectWindow(live, 'C:\\Work\\Beta', []).ok).toBe(false);
    });
  });

  describe('access rights: Windows has ACLs, not modes', () => {
    it('reports 0666 for every file, so the extension cannot rely on a mode check there', async () => {
      const file = path.join(dir, 'f.txt');
      await writeFile(file, 'x', { mode: 0o600 });
      expect((await stat(file)).mode & 0o777).toBe(0o666);
    });

    // The extension sets no ACL of its own on the discovery folder or file (Node cannot, and the
    // security of the server rests on the token and the unguessable pipe name, see COMPATIBILITY.md).
    // What it relies on is that the folder inherits "this user, SYSTEM, Administrators" from the
    // user's profile. This test pins that: the file and its folder carry no access entry for
    // Everyone, Users or Authenticated Users that their parent does not already have. It asks icacls
    // by SID, so the answer does not depend on the language of Windows.
    it('writes the discovery folder and file without granting Everyone, Users or Authenticated Users access', async () => {
      const directory = path.join(dir, 'ai-mcp');
      const file = await writeDiscovery(directory, 'a.json', {
        version: DISCOVERY_VERSION,
        socketPath: `\\\\.\\pipe\\fm-ai-${'b'.repeat(32)}`,
        pid: process.pid,
        startTime: 'x',
        token: newToken(),
        workspaceFolders: [],
        label: 'acl',
        created: 'x'
      });
      expect(JSON.parse(await readFile(file, 'utf8')).token).toMatch(/^[0-9a-f]{64}$/);

      const broad = { Everyone: 'S-1-1-0', Users: 'S-1-5-32-545', 'Authenticated Users': 'S-1-5-11' };
      const has = async (target: string, sid: string): Promise<boolean> => {
        const output = await icacls([target, '/findsid', `*${sid}`]);
        return output.toLowerCase().includes(path.basename(target).toLowerCase());
      };
      for (const [name, sid] of Object.entries(broad)) {
        const parentHas = await has(dir, sid);
        if (!parentHas) {
          expect(await has(directory, sid), `${name} on the folder`).toBe(false);
          expect(await has(file, sid), `${name} on the file`).toBe(false);
        }
      }
      // For the record in the CI log: the real entries.
      console.log(`discovery file ACL:\n${await icacls([file])}`);
    });
  });
});

