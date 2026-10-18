import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newToken } from '../../../../src/ai/mcp/auth';
import {
  DISCOVERY_VERSION,
  assertOwnerOnly,
  discoveryFileName,
  ensureOwnerOnlyDirectory,
  parseDiscovery,
  removeDiscovery,
  scanDiscovery,
  selectWindow,
  writeDiscovery,
  type DiscoveryRecord,
  type Liveness
} from '../../../../src/ai/mcp/discovery';
import { createEndpoint } from '../../../../src/ai/mcp/socketPath';

const posix = process.platform !== 'win32';

function record(overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    version: DISCOVERY_VERSION,
    socketPath: '/tmp/x.sock',
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

  it.skipIf(!posix)('writes the folder 0700 and the file 0600, and removes it', async () => {
    const directory = join(base, 'ai-mcp');
    const file = await writeDiscovery(directory, 'a.json', record());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
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

  it.skipIf(!posix)('scan: live, stale (dead pid, other run), and unsafe files are told apart and nothing is deleted', async () => {
    const directory = join(base, 'ai-mcp');
    const live = record({ pid: 1, startTime: 'A', label: 'live' });
    const dead = record({ pid: 2, startTime: 'B', label: 'dead' });
    const reused = record({ pid: 3, startTime: 'old', label: 'reused' });
    await writeDiscovery(directory, 'live.json', live);
    await writeDiscovery(directory, 'dead.json', dead);
    await writeDiscovery(directory, 'reused.json', reused);
    await writeFile(join(directory, 'junk.json'), 'not json', { mode: 0o600 });
    await writeFile(join(directory, 'loose.json'), JSON.stringify(record()), { mode: 0o644 });
    await chmod(join(directory, 'loose.json'), 0o644);

    const scan = await scanDiscovery(directory, liveness([1, 3], { 1: 'A', 3: 'new' }));
    expect(scan.live.map((window) => window.record.label)).toEqual(['live']);
    expect(scan.stale.map((file) => file.split('/').pop()).sort()).toEqual(['dead.json', 'reused.json']);
    expect(scan.unsafe.map((entry) => entry.file.split('/').pop()).sort()).toEqual(['junk.json', 'loose.json']);
    await expect(stat(join(directory, 'dead.json'))).resolves.toBeDefined();
  });

  it.skipIf(!posix)('a pid that is not alive is stale even if a start time can still be read for it', async () => {
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

  it.skipIf(!posix)('a process with no readable start time is not live', async () => {
    const directory = join(base, 'ai-mcp');
    await writeDiscovery(directory, 'a.json', record({ pid: 9 }));
    const scan = await scanDiscovery(directory, liveness([9], {}));
    expect(scan.live).toHaveLength(0);
    expect(scan.stale).toHaveLength(1);
  });

  it.skipIf(!posix)('refuses to scan an unsafe folder', async () => {
    const open = join(base, 'open');
    await mkdir(open);
    await chmod(open, 0o755);
    await expect(scanDiscovery(open)).rejects.toThrow(/accessible by other users/);
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

  it('refuses an ambiguous or unknown name and lists the live windows', () => {
    const ambiguous = selectWindow([alpha, beta, other], 'shared');
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.message).toMatch(/2 windows match/);
    const unknown = selectWindow([alpha, beta], 'nope');
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toMatch(/No live window matches/);
  });
});

describe('createEndpoint', () => {
  it.skipIf(!posix)('makes a short socket path in an owner-only folder', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fm-ai-ep-'));
    try {
      const endpoint = await createEndpoint({ baseDirectory: base });
      expect(Buffer.byteLength(endpoint.path)).toBeLessThanOrEqual(100);
      expect(endpoint.path.endsWith('.sock')).toBe(true);
      const directory = endpoint.path.slice(0, endpoint.path.lastIndexOf('/'));
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await createEndpoint({ baseDirectory: base })).path).not.toBe(endpoint.path);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)('refuses an existing socket folder that others can read, and a path that is too long', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fm-ai-ep-'));
    try {
      const uid = process.getuid?.() ?? 0;
      await mkdir(join(base, `fmai-${uid}`), { mode: 0o755 });
      await chmod(join(base, `fmai-${uid}`), 0o755);
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
