import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newToken } from '../../../../src/ai/mcp/auth';
import {
  DISCOVERY_VERSION,
  assertOwnerOnly,
  discoveryFileName,
  isExpectedSocketPath,
  safeText,
  ensureOwnerOnlyDirectory,
  parseDiscovery,
  removeDiscovery,
  scanDiscovery,
  selectWindow,
  writeDiscovery,
  type DiscoveryRecord,
  type Liveness
} from '../../../../src/ai/mcp/discovery';
import { createEndpoint, socketFolderName } from '../../../../src/ai/mcp/socketPath';

const posix = process.platform !== 'win32';

const uid = process.getuid?.() ?? 0;
// Windows has no socket folders: the endpoint is a named pipe, and the 12 hex digits of the name
// make the pipe name 32 hex digits long.
const socketPath = (name = 'abcdef012345'): string =>
  posix ? `/tmp/${socketFolderName(uid, 'storage-a')}/${name}.sock` : `\\\\.\\pipe\\fm-ai-${name.padEnd(32, '0')}`;

function record(overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    version: DISCOVERY_VERSION,
    socketPath: socketPath(),
    pid: 4242,
    startTime: 'T1',
    token: newToken(),
    workspaceFolders: ['/work/alpha'],
    label: 'alpha',
    created: '2026-10-18T00:00:00.000Z',
    ...overrides
  };
}

const liveness = (alive: number[], starts: Record<number, string>): Liveness => ({
  alive: (pid) => alive.includes(pid),
  startTime: async (pid) => starts[pid]
});

describe('parseDiscovery', () => {
  it('accepts a complete record and rejects anything malformed', () => {
    const good = record();
    expect(parseDiscovery(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      '',
      'x',
      '{}',
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, pid: 0 }),
      JSON.stringify({ ...good, pid: 1.5 }),
      JSON.stringify({ ...good, token: 'short' }),
      JSON.stringify({ ...good, token: 'Z'.repeat(64) }),
      JSON.stringify({ ...good, socketPath: '' }),
      JSON.stringify({ ...good, workspaceFolders: [1] }),
      JSON.stringify({ ...good, startTime: '' })
    ]) {
      expect(parseDiscovery(bad), bad.slice(0, 50)).toBeUndefined();
    }
  });
});

describe('discoveryFileName', () => {
  it('is stable for the same window and differs between windows', () => {
    expect(discoveryFileName(['/a'], 1)).toBe(discoveryFileName(['/a'], 1));
    expect(discoveryFileName(['/a'], 1)).not.toBe(discoveryFileName(['/a'], 2));
    expect(discoveryFileName(['/a'], 1)).not.toBe(discoveryFileName(['/b'], 1));
    expect(discoveryFileName(['/a'], 1)).toMatch(/^[0-9a-f]{16}\.json$/);
  });
});

describe('files on disk', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'fm-ai-disc-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('writes the folder 0700 and the file 0600 (Unix), and removes it', async () => {
    const directory = join(base, 'ai-mcp');
    const file = await writeDiscovery(directory, 'a.json', record());
    if (posix) {
      // Windows reports 0666/0777 for every file whatever its ACL, so the modes mean nothing there.
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(parseDiscovery(await readFile(file, 'utf8'))).toBeDefined();
    await removeDiscovery(file);
    await expect(stat(file)).rejects.toThrow();
  });

  it.skipIf(!posix)('refuses a folder or file that others can read, and a symbolic link', async () => {
    const open = join(base, 'open');
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    await expect(assertOwnerOnly(open, 'directory')).rejects.toThrow(/accessible by other users/);
    await expect(ensureOwnerOnlyDirectory(open)).rejects.toThrow(/accessible by other users/);

    const safe = join(base, 'safe');
    await ensureOwnerOnlyDirectory(safe);
    const file = join(safe, 'a.json');
    await writeFile(file, '{}', { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(assertOwnerOnly(file, 'file')).rejects.toThrow(/accessible by other users/);

    await symlink(safe, join(base, 'link'));
    await expect(assertOwnerOnly(join(base, 'link'), 'directory')).rejects.toThrow(/symbolic link/);
    await expect(assertOwnerOnly(file, 'directory')).rejects.toThrow(/not a directory/);
  });

  it('scan: live, stale (dead pid, other run), and unsafe files are told apart and nothing is deleted', async () => {
    const directory = join(base, 'ai-mcp');
    const live = record({ pid: 1, startTime: 'A', label: 'live' });
    const dead = record({ pid: 2, startTime: 'B', label: 'dead' });
    const reused = record({ pid: 3, startTime: 'old', label: 'reused' });
    await writeDiscovery(directory, 'live.json', live);
    await writeDiscovery(directory, 'dead.json', dead);
    await writeDiscovery(directory, 'reused.json', reused);
    await writeFile(join(directory, 'junk.json'), 'not json', { mode: 0o600 });
    if (posix) {
      await writeFile(join(directory, 'loose.json'), JSON.stringify(record()), { mode: 0o644 });
      await chmod(join(directory, 'loose.json'), 0o644);
    }

    const scan = await scanDiscovery(directory, liveness([1, 3], { 1: 'A', 3: 'new' }));
    expect(scan.live.map((window) => window.record.label)).toEqual(['live']);
    expect(scan.stale.map((file) => basename(file)).sort()).toEqual(['dead.json', 'reused.json']);
    // The world-readable file is only unsafe where file modes exist.
    expect(scan.unsafe.map((entry) => basename(entry.file)).sort()).toEqual(posix ? ['junk.json', 'loose.json'] : ['junk.json']);
    await expect(stat(join(directory, 'dead.json'))).resolves.toBeDefined();
  });

  it('a pid that is not alive is stale even if a start time can still be read for it', async () => {
    const directory = join(base, 'ai-mcp');
    await writeDiscovery(directory, 'a.json', record({ pid: 7, startTime: 'S' }));
    const scan = await scanDiscovery(directory, { alive: () => false, startTime: async () => 'S' });
    expect(scan.live).toHaveLength(0);
    expect(scan.stale).toHaveLength(1);
  });

  it.skipIf(!posix)('refuses a folder or file owned by another user', async () => {
    const directory = join(base, 'ai-mcp');
    const file = await writeDiscovery(directory, 'a.json', record());
    const mine = process.getuid?.() as number;
    await expect(assertOwnerOnly(directory, 'directory', mine + 1)).rejects.toThrow(/not owned by the current user/);
    await expect(assertOwnerOnly(file, 'file', mine + 1)).rejects.toThrow(/not owned by the current user/);
    await expect(assertOwnerOnly(file, 'file', mine)).resolves.toBeUndefined();
  });

  it('a running process whose start time cannot be read is unverified: not live, and NOT stale', async () => {
    const directory = join(base, 'ai-mcp');
    await writeDiscovery(directory, 'a.json', record({ pid: 9 }));
    const scan = await scanDiscovery(directory, liveness([9], {}));
    expect(scan.live).toHaveLength(0);
    expect(scan.stale).toHaveLength(0);
    expect(scan.unverified.map((window) => window.record.pid)).toEqual([9]);
  });

  it('a file that names a socket this extension would not create is unsafe', async () => {
    const directory = join(base, 'ai-mcp');
    await writeDiscovery(directory, 'a.json', record({ pid: 1, startTime: 'A', socketPath: '/tmp/evil.sock' }));
    await writeDiscovery(directory, 'b.json', record({ pid: 1, startTime: 'A', socketPath: `/etc/${socketFolderName(uid, 'storage-a')}/../x.sock` }));
    const scan = await scanDiscovery(directory, liveness([1], { 1: 'A' }));
    expect(scan.live).toHaveLength(0);
    expect(scan.unsafe.map((entry) => entry.reason)).toEqual(Array(2).fill('it names a socket this extension would not create'));
  });

  it.skipIf(!posix)('refuses to scan an unsafe folder', async () => {
    const open = join(base, 'open');
    await mkdir(open);
    await chmod(open, 0o755);
    await expect(scanDiscovery(open)).rejects.toThrow(/accessible by other users/);
  });
});

describe('isExpectedSocketPath', () => {
  it('accepts only the socket and pipe names the extension creates', () => {
    expect(isExpectedSocketPath(socketPath(), uid)).toBe(true);
    expect(isExpectedSocketPath('\\\\.\\pipe\\fm-ai-' + 'a'.repeat(32), uid)).toBe(true);
    for (const bad of [
      '/tmp/evil.sock',
      `/tmp/${socketFolderName(uid + 1, 'storage-a')}/abcdef012345.sock`,
      `/tmp/${socketFolderName(uid, 'storage-a')}/abcdef012345.sockx`,
      `/tmp/${socketFolderName(uid, 'storage-a')}/ABCDEF012345.sock`,
      `/tmp/other/${socketFolderName(uid, 'storage-a')}/../abcdef012345.sock`,
      `${socketFolderName(uid, 'storage-a')}/abcdef012345.sock`,
      `/tmp/fmai-${uid}/abcdef012345.sock`,
      `/tmp/fmai-${uid}-zzzzzzzz/abcdef012345.sock`,
      `/tmp/fmai-${uid}-abcd1234ab/abcdef012345.sock`,
      '\\\\.\\pipe\\other',
      '\\\\.\\pipe\\fm-ai-short'
    ]) {
      expect(isExpectedSocketPath(bad, uid), bad).toBe(false);
    }
  });
});

describe('safeText', () => {
  it('keeps printable ASCII only and cuts long text', () => {
    expect(safeText('a\nb\u001b[31m\u202Ec')).toBe('a?b?[31m?c');
    expect(safeText('x'.repeat(500)).length).toBe(200);
  });
});

describe('selectWindow', () => {
  const window = (label: string, folders: string[], pid: number) => ({ file: `${label}.json`, record: record({ label, workspaceFolders: folders, pid }) });
  const alpha = window('alpha', ['/work/alpha'], 1);
  const beta = window('beta', ['/work/beta', '/work/shared'], 2);
  const other = window('other', ['/other/shared'], 3);

  it('uses the only live window, and explains when there is none', () => {
    expect(selectWindow([alpha], undefined)).toEqual({ ok: true, window: alpha });
    const none = selectWindow([], undefined);
    expect(none.ok).toBe(false);
    expect(!none.ok && none.message).toMatch(/externalServer/);
  });

  it('refuses to guess among several windows and lists the choices', () => {
    const result = selectWindow([alpha, beta], undefined);
    expect(result.ok).toBe(false);
    const message = !result.ok ? result.message : '';
    expect(message).toMatch(/not guessing/);
    expect(message).toContain('alpha');
    expect(message).toContain('beta');
    expect(message).not.toMatch(/[0-9a-f]{64}/);
  });

  it('matches by folder path, folder name or label, exactly one', () => {
    expect(selectWindow([alpha, beta], '/work/beta')).toEqual({ ok: true, window: beta });
    expect(selectWindow([alpha, beta], 'alpha')).toEqual({ ok: true, window: alpha });
    expect(selectWindow([alpha, beta], 'beta')).toEqual({ ok: true, window: beta });
  });

  it('explains an unverified window instead of saying none is running, and never prints control characters', () => {
    const unverified = window('al\u001b[2Jpha', ['/w/\nx'], 5);
    const result = selectWindow([], undefined, [unverified]);
    expect(result.ok).toBe(false);
    const message = !result.ok ? result.message : '';
    expect(message).toMatch(/Could not verify the window/);
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('/w/\nx');
    expect(message).toContain('al?[2Jpha');
    const unknown = selectWindow([alpha], 'x\u001b[31my');
    expect(!unknown.ok && unknown.message).not.toContain('\u001b');
  });

  it('refuses an ambiguous or unknown name and lists the live windows', () => {
    const ambiguous = selectWindow([alpha, beta, other], 'shared');
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.message).toMatch(/2 windows match/);
    const unknown = selectWindow([alpha, beta], 'nope');
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toMatch(/No live window matches/);
  });
});

describe('socketFolderName', () => {
  it('is per user and per storage path, so products sharing a temp folder do not share a socket folder', () => {
    expect(socketFolderName(501, '/code/storage')).toBe(socketFolderName(501, '/code/storage'));
    expect(socketFolderName(501, '/code/storage')).not.toBe(socketFolderName(501, '/cursor/storage'));
    expect(socketFolderName(501, '/code/storage')).not.toBe(socketFolderName(502, '/code/storage'));
    expect(socketFolderName(501, '/x')).toMatch(/^fmai-501-[0-9a-f]{8}$/);
  });

  it.skipIf(!posix)('createEndpoint puts different storage paths in different folders under the macOS length limit', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fmp-'));
    try {
      const a = await createEndpoint({ baseDirectory: base, scope: '/code/storage' });
      const b = await createEndpoint({ baseDirectory: base, scope: '/cursor/storage' });
      expect(dirname(a.path)).not.toBe(dirname(b.path));
      expect(isExpectedSocketPath(a.path, uid)).toBe(true);
      expect(Buffer.byteLength(a.path)).toBeLessThanOrEqual(103);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('createEndpoint folder choice', () => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  it.skipIf(!posix)('ignores an empty or relative XDG_RUNTIME_DIR and uses the temp folder, so the socket path is always absolute', async () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    try {
      for (const bad of ['', 'relative/run']) {
        process.env.XDG_RUNTIME_DIR = bad;
        const endpoint = await createEndpoint({ scope: `scope-${bad || 'empty'}` });
        expect(endpoint.path.startsWith('/')).toBe(true);
        expect(endpoint.path.startsWith(tmpdir())).toBe(true);
        await rm(dirname(endpoint.path), { recursive: true, force: true });
      }
    } finally {
      restore('XDG_RUNTIME_DIR', saved);
    }
  });

  it.skipIf(!posix)('falls back to the temp folder when XDG_RUNTIME_DIR cannot be used, but never when the caller named a folder', async () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    // A folder "inside a file" cannot be created on any system (ENOTDIR), and fails fast.
    const holder = await mkdtemp(join(tmpdir(), 'fmu-'));
    const blocked = join(holder, 'file', 'run');
    try {
      await writeFile(join(holder, 'file'), 'x');
      process.env.XDG_RUNTIME_DIR = blocked;
      const endpoint = await createEndpoint({ scope: 'fallback' });
      expect(endpoint.path.startsWith(tmpdir())).toBe(true);
      await rm(dirname(endpoint.path), { recursive: true, force: true });
      await expect(createEndpoint({ baseDirectory: blocked, scope: 'explicit' })).rejects.toThrow();
    } finally {
      restore('XDG_RUNTIME_DIR', saved);
      await rm(holder, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)('uses an absolute XDG_RUNTIME_DIR when it is set', async () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    const run = await mkdtemp(join(tmpdir(), 'fmx-'));
    try {
      process.env.XDG_RUNTIME_DIR = run;
      const endpoint = await createEndpoint({ scope: 'xdg' });
      expect(endpoint.path.startsWith(run)).toBe(true);
    } finally {
      restore('XDG_RUNTIME_DIR', saved);
      await rm(run, { recursive: true, force: true });
    }
  });
});

describe('createEndpoint', () => {
  it.skipIf(!posix)('makes a short socket path in an owner-only folder', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fmp-'));
    try {
      const endpoint = await createEndpoint({ baseDirectory: base });
      expect(Buffer.byteLength(endpoint.path)).toBeLessThanOrEqual(103);
      expect(endpoint.path.endsWith('.sock')).toBe(true);
      const directory = endpoint.path.slice(0, endpoint.path.lastIndexOf('/'));
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await createEndpoint({ baseDirectory: base })).path).not.toBe(endpoint.path);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)('refuses an existing socket folder that others can read, and a path that is too long', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fmp-'));
    try {
      const uid = process.getuid?.() ?? 0;
      await mkdir(join(base, socketFolderName(uid, undefined)), { mode: 0o755 });
      await chmod(join(base, socketFolderName(uid, undefined)), 0o755);
      await expect(createEndpoint({ baseDirectory: base })).rejects.toThrow(/accessible by other users/);
      const long = join(base, 'x'.repeat(90));
      await expect(createEndpoint({ baseDirectory: long })).rejects.toThrow(/byte limit/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('uses an unguessable named pipe on Windows', async () => {
    const a = await createEndpoint({ platform: 'win32' });
    const b = await createEndpoint({ platform: 'win32' });
    expect(a.path).toMatch(/^\\\\\.\\pipe\\fm-ai-[0-9a-f]{32}$/);
    expect(a.path).not.toBe(b.path);
    expect(a.isPipe).toBe(true);
  });
});
