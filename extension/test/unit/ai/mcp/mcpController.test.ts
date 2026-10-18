/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from 'child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'fs/promises';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { AI_TOOL_DEFINITIONS } from '../../../../src/ai/aiToolDefinitions';
import { AiMcpController } from '../../../../src/ai/mcp/aiMcpController';
import { newToken } from '../../../../src/ai/mcp/auth';
import { DISCOVERY_VERSION, parseDiscovery, writeDiscovery } from '../../../../src/ai/mcp/discovery';
import { buildMcpConfig, discoveryDirectory, installedShimPath, installShim } from '../../../../src/ai/mcp/mcpConfig';
import { getProcessStartTime } from '../../../../src/ai/mcp/processInfo';
import { createEndpoint, probeSocket, removeStaleSockets, socketFolderName } from '../../../../src/ai/mcp/socketPath';
import { registerAiMcpCommands, watchExternalServerSetting } from '../../../../src/commands/aiMcp';
import { RawClient } from './mcpClientHelper';

const posix = process.platform !== 'win32';

/** A socket file with nothing listening on it: a child listens, then is killed without cleaning up. */
async function leaveDeadSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(process.argv[1], () => console.log('up'))`, path], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

describe('AiMcpController', () => {
  let storage: string;
  let enabled: boolean;
  let remote: string | undefined;
  let flag: number | undefined;
  let epoch: number;
  let seen: boolean | undefined;
  let notify: ReturnType<typeof vi.fn>;
  let controller: AiMcpController;
  let startTimeOverride: (() => Promise<string | undefined>) | undefined;
  const core = { listTools: () => AI_TOOL_DEFINITIONS.filter((t) => t.kind === 'read'), invoke: vi.fn(async () => ({})) };

  function make(overrides: Record<string, unknown> = {}): AiMcpController {
    return new AiMcpController({
      core: core as never,
      globalStoragePath: storage,
      serverInfo: { name: 'x', version: '1' },
      isEnabled: () => enabled,
      remoteName: () => remote,
      workspaceFolders: () => ['/work/alpha'],
      state: { get: () => flag, set: (value) => void (flag = value) },
      permission: { epoch: () => epoch, bump: () => void (epoch += 1), seenEnabled: () => seen, setSeenEnabled: (value) => void (seen = value) },
      log: () => undefined,
      notify: notify as never,
      processStartTime: startTimeOverride,
      ...overrides
    });
  }

  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'fmc-'));
    enabled = true;
    remote = undefined;
    flag = undefined;
    epoch = 0;
    seen = undefined;
    notify = vi.fn();
    startTimeOverride = undefined;
    controller = make();
  });

  afterEach(async () => {
    await controller.stop();
    await rm(storage, { recursive: true, force: true });
  });

  const files = async () => (await readdir(discoveryDirectory(storage)).catch(() => [])).filter((name) => name.endsWith('.json'));
  const record = async () => parseDiscovery(await readFile(join(discoveryDirectory(storage), (await files())[0] as string), 'utf8'))!;

  describe('the setting is only a permission', () => {
    it('does not autostart without the "started here" flag, even with the setting on', async () => {
      enabled = true;
      flag = undefined;
      await controller.autostart();
      expect(controller.isRunning()).toBe(false);
      expect(await files()).toEqual([]);
    });

    it('does not autostart with the flag but without the setting, and does not even try', async () => {
      const log = vi.fn();
      const quiet = make({ log });
      enabled = false;
      flag = epoch;
      await quiet.autostart();
      expect(quiet.isRunning()).toBe(false);
      expect(log).not.toHaveBeenCalled();
      expect(await files()).toEqual([]);
    });

    it('autostarts with both, and reports a failure instead of throwing', async () => {
      flag = epoch;
      await controller.autostart();
      expect(controller.isRunning()).toBe(true);
      await controller.stop();
      remote = 'ssh-remote';
      await expect(controller.autostart()).resolves.toBeUndefined();
      expect(controller.isRunning()).toBe(false);
    });

    it('a plain start (what any caller can do) remembers nothing; only startHere does, and only when it worked', async () => {
      await controller.start();
      expect(flag).toBeUndefined();
      await controller.stop();
      await controller.startHere();
      expect(flag).toBe(epoch);
      expect(controller.isRunning()).toBe(true);
      await controller.stopHere();
      expect(flag).toBeUndefined();
      remote = 'wsl';
      await expect(controller.startHere()).rejects.toThrow(/remote windows/);
      expect(flag).toBeUndefined();
    });

    it('stopHere stops and clears the flag, so the server does not come back on the next launch', async () => {
      await controller.startHere();
      await controller.stopHere();
      expect(controller.isRunning()).toBe(false);
      expect(flag).toBeUndefined();
      const next = make();
      await next.autostart();
      expect(next.isRunning()).toBe(false);
      await next.stop();
    });

    it('turning the setting off stops the server, clears the flag and advances the permission epoch', async () => {
      await controller.startHere();
      const before = epoch;
      enabled = false;
      await controller.handleSettingChange();
      expect(controller.isRunning()).toBe(false);
      expect(flag).toBeUndefined();
      expect(epoch).toBe(before + 1);
      enabled = true;
      await controller.autostart();
      expect(controller.isRunning()).toBe(false);
    });

    it('a workspace that was closed when the setting was turned off does not revive when it is turned on again', async () => {
      // Another workspace started the server in the current epoch and is closed (its own flag store).
      let otherFlag: number | undefined = epoch;
      const other = make({ state: { get: () => otherFlag, set: (value: number | undefined) => void (otherFlag = value) } });
      // This window sees the setting turned off, then on again.
      seen = true;
      enabled = false;
      await controller.handleSettingChange();
      enabled = true;
      await controller.handleSettingChange();
      // The closed workspace opens later.
      await other.autostart();
      expect(other.isRunning()).toBe(false);
      expect(otherFlag).not.toBe(epoch);
      // Starting it there again, on purpose, works.
      await other.startHere();
      expect(other.isRunning()).toBe(true);
      expect(otherFlag).toBe(epoch);
      await other.stop();
    });

    it('a setting turned off while no window was open ends the old flags too, once', async () => {
      seen = true; // the last state any window saw
      flag = epoch;
      enabled = false; // changed in settings.json with VS Code closed
      await controller.autostart();
      const after = epoch;
      expect(after).toBe(1);
      enabled = true;
      await controller.autostart();
      expect(controller.isRunning()).toBe(false);
      enabled = false;
      await controller.handleSettingChange();
      expect(epoch).toBe(after + 1); // turned on and off again: a new "off"
      await controller.handleSettingChange();
      expect(epoch).toBe(after + 1); // the same "off" seen twice counts once
    });

    it('turning the setting on does not start anything', async () => {
      enabled = true;
      await controller.handleSettingChange();
      expect(controller.isRunning()).toBe(false);
      expect(seen).toBe(true);
    });
  });

  describe('start', () => {
    it('refuses when the setting is off, in remote windows, and without a usable storage folder', async () => {
      enabled = false;
      await expect(controller.start()).rejects.toThrow(/externalServer\.enabled/);
      enabled = true;
      for (const name of ['dev-container', 'codespaces', 'ssh-remote', 'wsl']) {
        remote = name;
        await expect(controller.start()).rejects.toThrow(/not supported in remote windows/);
      }
      remote = undefined;
      for (const bad of [undefined, '', 'relative/storage']) {
        await expect(make({ globalStoragePath: bad }).start()).rejects.toThrow(/storage folder is not available/);
      }
      expect(await files()).toEqual([]);
    });

    it('refuses to start when the process start time cannot be read, and leaves nothing behind', async () => {
      startTimeOverride = async () => undefined;
      const blocked = make();
      await expect(blocked.start()).rejects.toThrow(/start time/);
      expect(blocked.isRunning()).toBe(false);
      expect(await files()).toEqual([]);
      expect(await readdir(storage)).toEqual([]);
    });

    it('stop waits for a start that is still in progress, so nothing is left running', async () => {
      let release: (value: string) => void = () => undefined;
      const slow = make({ processStartTime: () => new Promise<string | undefined>((resolve) => (release = resolve)) });
      const starting = slow.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stopping = slow.stop();
      release((await getProcessStartTime(process.pid)) as string);
      await Promise.allSettled([starting, stopping]);
      await stopping;
      // The start finished first (it was already running); stop ran after it and ended it.
      expect(slow.isRunning()).toBe(false);
      expect(await files()).toEqual([]);
    });

    it('two starts at the same moment make one server and one file', async () => {
      await Promise.all([controller.start(), controller.start(), controller.startHere()]);
      expect(await files()).toHaveLength(1);
      expect(controller.isRunning()).toBe(true);
      const first = await record();
      await controller.start();
      expect((await record()).socketPath).toBe(first.socketPath);
    });

    it('writes a 0600 discovery file with this process\'s identity, and a client can connect with its token', async () => {
      await controller.start();
      const rec = await record();
      const file = join(discoveryDirectory(storage), (await files())[0] as string);
      expect(rec).toMatchObject({ version: DISCOVERY_VERSION, pid: process.pid, workspaceFolders: ['/work/alpha'] });
      expect(rec.startTime).toBe(await getProcessStartTime(process.pid));
      expect(rec.token).toMatch(/^[0-9a-f]{64}$/);
      if (posix) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await stat(discoveryDirectory(storage))).mode & 0o777).toBe(0o700);
        expect((await stat(rec.socketPath)).mode & 0o777).toBe(0o600);
      }
      const client = await RawClient.connect(rec.socketPath);
      expect(await client.hello(rec.token)).toBe('{"hello":"ok"}');
      expect(controller.connectionCount()).toBe(1);
      client.close();
    });

    it('stops the server and removes everything when writing the discovery file fails', async () => {
      // A file where the discovery folder should be makes the write fail after the socket exists.
      await writeFile(discoveryDirectory(storage), 'in the way');
      const failing = make();
      let socketPath: string | undefined;
      const probe = vi.spyOn(net, 'createServer');
      await expect(failing.start()).rejects.toThrow();
      socketPath = (probe.mock.results[0]?.value as net.Server | undefined)?.listening === false ? 'closed' : undefined;
      probe.mockRestore();
      expect(failing.isRunning()).toBe(false);
      expect(socketPath).toBe('closed');
    });

    it('removes its exit hook when it stops', async () => {
      const before = process.listenerCount('exit');
      await controller.start();
      expect(process.listenerCount('exit')).toBe(before + 1);
      await controller.stop();
      expect(process.listenerCount('exit')).toBe(before);
    });

    it('keeps the token out of the copied configuration', async () => {
      await controller.start();
      const rec = await record();
      const config = JSON.stringify(buildMcpConfig({ shimPath: '/s/aiMcpShim.js', discoveryDir: discoveryDirectory(storage), workspaceFolder: '/work/alpha' }));
      expect(config).not.toContain(rec.token);
    });
  });

  describe('stop', () => {
    it('removes the discovery file, closes connections and the socket, and can be repeated', async () => {
      await controller.start();
      const rec = await record();
      const client = await RawClient.connect(rec.socketPath);
      await client.hello(rec.token);
      await controller.stop();
      expect(await client.waitClosed()).toBe(true);
      expect(await files()).toEqual([]);
      if (posix) await expect(stat(rec.socketPath)).rejects.toThrow();
      await controller.stop();
    });
  });

  describe('stale files', () => {
    it('removes discovery files of dead processes, keeps live ones and ones it cannot verify', async () => {
      const directory = discoveryDirectory(storage);
      const base = { version: DISCOVERY_VERSION as 1, socketPath: `/tmp/${socketFolderName(process.getuid?.() ?? 0, undefined)}/abcdef012345.sock`, token: newToken(), workspaceFolders: [], created: 'x' };
      await writeDiscovery(directory, 'dead.json', { ...base, pid: 2_147_483_000, startTime: 'x', label: 'dead' });
      await writeDiscovery(directory, 'other-run.json', { ...base, pid: process.pid, startTime: 'not-this-run', label: 'other-run' });
      await controller.start();
      const names = await files();
      expect(names).not.toContain('dead.json');
      expect(names).not.toContain('other-run.json');
      expect(names).toHaveLength(1);
    });

    it.skipIf(!posix)('does not delete a file whose process is running but whose start time cannot be read', async () => {
      const directory = discoveryDirectory(storage);
      const unreadable = { version: DISCOVERY_VERSION as 1, socketPath: `/tmp/${socketFolderName(process.getuid?.() ?? 0, undefined)}/abcdef012345.sock`, token: newToken(), workspaceFolders: [], created: 'x', label: 'unreadable', pid: 1, startTime: 'whatever' };
      await writeDiscovery(directory, 'unreadable.json', unreadable);
      const unreadableLiveness = { alive: () => true, startTime: async () => undefined };
      const mod = await import('../../../../src/ai/mcp/discovery');
      const scan = await mod.scanDiscovery(directory, unreadableLiveness);
      expect(scan.stale).toEqual([]);
      expect(scan.unverified).toHaveLength(1);
      const careful = make({ liveness: unreadableLiveness });
      await careful.start();
      expect(await files()).toContain('unreadable.json');
      await careful.stop();
    });

    it.skipIf(!posix)('removes dead sockets nobody uses, but not young ones, named ones, live listeners, or other kinds of file', async () => {
      const endpoint = await createEndpoint({ baseDirectory: storage, scope: storage });
      const directory = endpoint.path.slice(0, endpoint.path.lastIndexOf('/'));
      const dead = join(directory, 'aaaaaaaaaaaa.sock');
      const young = join(directory, 'bbbbbbbbbbbb.sock');
      const named = join(directory, 'cccccccccccc.sock');
      const text = join(directory, 'dddddddddddd.sock');
      const live = join(directory, 'eeeeeeeeeeee.sock');
      for (const path of [dead, young, named]) await leaveDeadSocket(path);
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(live, resolve));
      await writeFile(text, 'not a socket');
      const past = new Date(Date.now() - 120_000);
      for (const path of [dead, named, text, live]) await utimes(path, past, past);

      try {
        const removed = await removeStaleSockets(directory, new Set([named]));
        expect(removed).toEqual([dead]);
        const left = await readdir(directory);
        for (const name of ['bbbbbbbbbbbb.sock', 'cccccccccccc.sock', 'dddddddddddd.sock', 'eeeeeeeeeeee.sock']) expect(left).toContain(name);
        expect(left).not.toContain('aaaaaaaaaaaa.sock');
        expect(await probeSocket(live)).toBe('alive');
      } finally {
        server.close();
      }
    });

    it.skipIf(!posix)('probeSocket tells a dead socket, a missing one and a live one apart', async () => {
      const endpoint = await createEndpoint({ baseDirectory: storage, scope: storage });
      const directory = endpoint.path.slice(0, endpoint.path.lastIndexOf('/'));
      const dead = join(directory, '111111111111.sock');
      await leaveDeadSocket(dead);
      expect(await probeSocket(dead)).toBe('dead');
      expect(await probeSocket(join(directory, '222222222222.sock'))).toBe('dead');
      const live = join(directory, '333333333333.sock');
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(live, resolve));
      expect(await probeSocket(live)).toBe('alive');
      server.close();
      // A plain file is not a listener (Linux reports a refused connection, macOS a different error).
      const notSocket = join(directory, '444444444444.sock');
      await writeFile(notSocket, 'x');
      expect(await probeSocket(notSocket)).not.toBe('alive');
    });

    it.skipIf(!posix)('a start removes a leftover socket of a dead server in its own folder but leaves a young one (a window starting at the same moment)', async () => {
      const endpoint = await createEndpoint({ scope: storage });
      const directory = endpoint.path.slice(0, endpoint.path.lastIndexOf('/'));
      const leftover = join(directory, 'eeeeeeeeeeee.sock');
      const fresh = join(directory, 'ffffffffffff.sock');
      await leaveDeadSocket(leftover);
      await leaveDeadSocket(fresh);
      const past = new Date(Date.now() - 120_000);
      await utimes(leftover, past, past);
      try {
        await controller.start();
        const left = await readdir(directory);
        expect(left).not.toContain('eeeeeeeeeeee.sock');
        expect(left).toContain('ffffffffffff.sock');
      } finally {
        await rm(fresh, { force: true });
        await rm(leftover, { force: true });
      }
    });

    it.skipIf(!posix)('two products sharing one temp folder never delete each other\'s live socket (separate storage, separate socket folders)', async () => {
      const root = await mkdtemp(join(tmpdir(), 'fmq-'));
      const storageA = join(root, 'code');
      const storageB = join(root, 'cursor');
      try {
        const a = await createEndpoint({ baseDirectory: root, scope: storageA });
        const b = await createEndpoint({ baseDirectory: root, scope: storageB });
        expect(a.path.slice(0, a.path.lastIndexOf('/'))).not.toBe(b.path.slice(0, b.path.lastIndexOf('/')));

        // Product A has a server that has been listening for two minutes.
        const live = net.createServer();
        await new Promise<void>((resolve) => live.listen(a.path, resolve));
        const past = new Date(Date.now() - 120_000);
        await utimes(a.path, past, past);

        // Product B starts (here through the controller; B's baseDirectory is the shared root).
        const previous = process.env.TMPDIR;
        const previousRuntime = process.env.XDG_RUNTIME_DIR;
        process.env.TMPDIR = root;
        delete process.env.XDG_RUNTIME_DIR;
        const cursor = make({ globalStoragePath: storageB });
        try {
          await cursor.start();
          expect((await stat(a.path)).isSocket()).toBe(true);
          expect(await probeSocket(a.path)).toBe('alive');
        } finally {
          await cursor.stop();
          // Assigning undefined to process.env stores the text "undefined": restore by deleting.
          if (previous === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = previous;
          if (previousRuntime !== undefined) process.env.XDG_RUNTIME_DIR = previousRuntime;
          live.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it.skipIf(!posix)('even inside one folder, removeStaleSockets never deletes a socket that something listens on', async () => {
      const endpoint = await createEndpoint({ baseDirectory: storage, scope: storage });
      const directory = endpoint.path.slice(0, endpoint.path.lastIndexOf('/'));
      const path = join(directory, 'abababababab.sock');
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(path, resolve));
      const past = new Date(Date.now() - 600_000);
      await utimes(path, past, past);
      try {
        expect(await removeStaleSockets(directory, new Set())).toEqual([]);
        expect((await stat(path)).isSocket()).toBe(true);
      } finally {
        server.close();
      }
    });
  });

  describe('visibility', () => {
    it('tells the user when an external program connects (not more than every 30 seconds) and updates the count', async () => {
      await controller.start();
      const rec = await record();
      const changes = vi.fn();
      controller.onDidChange(changes);
      const a = await RawClient.connect(rec.socketPath);
      await a.hello(rec.token);
      const b = await RawClient.connect(rec.socketPath);
      await b.hello(rec.token);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(String(notify.mock.calls[0]?.[0])).toMatch(/external program connected/);
      expect(controller.connectionCount()).toBe(2);
      expect(changes).toHaveBeenCalledTimes(2);
      a.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(controller.connectionCount()).toBe(1);
      expect(changes).toHaveBeenCalledTimes(3);
      b.close();
    });
  });
});

describe('installShim', () => {
  it('copies the shim to a stable path in storage, replacing an older copy, and falls back to the original on failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fm-ai-shim-'));
    try {
      const source = join(dir, 'ext-1.0.0', 'aiMcpShim.js');
      await mkdir(join(dir, 'ext-1.0.0'));
      await writeFile(source, 'v1');
      const storage = join(dir, 'storage');
      expect(await installShim(source, storage)).toEqual({ path: installedShimPath(storage), stable: true });
      expect(await readFile(installedShimPath(storage), 'utf8')).toBe('v1');
      const next = join(dir, 'ext-1.1.0', 'aiMcpShim.js');
      await mkdir(join(dir, 'ext-1.1.0'));
      await writeFile(next, 'v2');
      expect((await installShim(next, storage)).path).toBe(installedShimPath(storage));
      expect(await readFile(installedShimPath(storage), 'utf8')).toBe('v2');
      const missing = await installShim(join(dir, 'nope.js'), storage);
      expect(missing).toEqual({ path: join(dir, 'nope.js'), stable: false });
      expect((await readdir(join(storage, 'ai-mcp-shim'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('installShim hardening', () => {
  let dir: string;
  let source: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fmi-'));
    source = join(dir, 'aiMcpShim.js');
    await writeFile(source, 'shim-content');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!posix)('writes an owner-only copy with the same content and verifies it', async () => {
    const storage = join(dir, 'storage');
    const result = await installShim(source, storage);
    expect(result.stable).toBe(true);
    expect((await stat(installedShimPath(storage))).mode & 0o777).toBe(0o700);
    expect((await stat(join(storage, 'ai-mcp-shim'))).mode & 0o777).toBe(0o700);
    expect(await readFile(installedShimPath(storage), 'utf8')).toBe('shim-content');
  });

  it.skipIf(!posix)('does not write through a symbolic link in place of the shim folder', async () => {
    const storage = join(dir, 'storage');
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(storage);
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, join(storage, 'ai-mcp-shim'));
    const result = await installShim(source, storage);
    expect(result).toEqual({ path: source, stable: false });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it.skipIf(!posix)('does not use a shim folder that other users can write to', async () => {
    const storage = join(dir, 'storage');
    await mkdir(join(storage, 'ai-mcp-shim'), { recursive: true });
    await chmod(join(storage, 'ai-mcp-shim'), 0o777);
    const result = await installShim(source, storage);
    expect(result).toEqual({ path: source, stable: false });
    expect(await readdir(join(storage, 'ai-mcp-shim'))).toEqual([]);
  });

  it.skipIf(!posix)('does not keep a copy when the file read back is not what was written', async () => {
    const storage = join(dir, 'storage');
    const { readFile: realRead } = await import('fs/promises');
    let calls = 0;
    const result = await installShim(source, storage, (async (...args: Parameters<typeof realRead>) => {
      calls += 1;
      return calls === 2 ? Buffer.from('tampered') : realRead(...args);
    }) as typeof realRead);
    expect(result.stable).toBe(false);
    expect(await readdir(join(storage, 'ai-mcp-shim'))).toEqual([]); // the unverified copy is removed
  });
});

describe('buildMcpConfig', () => {
  it('names node, the shim, the discovery folder and the workspace', () => {
    expect(buildMcpConfig({ shimPath: '/e/aiMcpShim.js', discoveryDir: '/g/ai-mcp', workspaceFolder: '/w' })).toEqual({
      mcpServers: { filemaker: { command: 'node', args: ['/e/aiMcpShim.js', '--dir', '/g/ai-mcp', '--workspace', '/w'] } }
    });
    expect(buildMcpConfig({ shimPath: 's', discoveryDir: 'd' }).mcpServers.filemaker.args).toEqual(['s', '--dir', 'd']);
  });
});

describe('AI server commands', () => {
  const command = (name: string) => {
    const callback = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === name)?.[1];
    if (!callback) throw new Error(`${name} missing`);
    return callback;
  };
  let controller: any;
  let enabled: boolean;
  let update: ReturnType<typeof vi.fn>;
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'fm-ai-cmd-'));
    enabled = false;
    update = vi.fn(async () => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ update, get: vi.fn(), inspect: vi.fn() } as never);
    (vscode as any).ConfigurationTarget.Global = 1;
    controller = { isRunning: vi.fn(() => false), startHere: vi.fn(async () => undefined), stopHere: vi.fn(async () => undefined) };
    await mkdir(join(dir, 'ext', 'dist'), { recursive: true });
    await writeFile(join(dir, 'ext', 'dist', 'aiMcpShim.js'), '//shim');
    registerAiMcpCommands({ controller, extensionPath: join(dir, 'ext'), globalStoragePath: join(dir, 'global'), isEnabled: () => enabled, refresh: vi.fn() });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('always asks in a modal that says exactly what starting does, also when the setting is already on, so a caller cannot start it silently', async () => {
    for (const settingOn of [false, true]) {
      enabled = settingOn;
      controller.startHere.mockClear();
      update.mockClear();
      vi.mocked(vscode.window.showWarningMessage).mockClear();
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
      await command('filemakerDataApiTools.toggleAiServer')();
      expect(update).not.toHaveBeenCalled();
      expect(controller.startHere).not.toHaveBeenCalled();
      const [, options, label] = vi.mocked(vscode.window.showWarningMessage).mock.calls[0] as unknown as [string, { modal: boolean; detail: string }, string];
      expect(options.modal).toBe(true);
      expect(label).toBe(settingOn ? 'Start Here' : 'Turn On and Start');
      expect(options.detail).toMatch(/THIS window only/);
      expect(options.detail).toMatch(/start the server automatically each time you open it/);
      expect(options.detail).toMatch(/until you run this command again to stop it/);
      expect(options.detail).toMatch(/Other windows are not affected/);
      expect(options.detail).toMatch(/model provider/);
      expect(/only a permission/.test(options.detail)).toBe(!settingOn);
      expect(/ends the automatic start for every workspace/.test(options.detail)).toBe(!settingOn);
    }
  });

  it('turns the setting on only after the user confirms, then starts here', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Turn On and Start' as never);
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(update).toHaveBeenCalledWith('ai.externalServer.enabled', true, 1);
    expect(controller.startHere).toHaveBeenCalledTimes(1);
  });

  it('starts here after a confirmation when the setting is on, stops here when running (no dialog), and reports errors', async () => {
    enabled = true;
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Start Here' as never);
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(controller.startHere).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(String(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0])).toMatch(/starts again when you reopen this workspace until you stop it here/);

    vi.mocked(vscode.window.showWarningMessage).mockClear();
    controller.isRunning.mockReturnValue(true);
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(controller.stopHere).toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(String(vi.mocked(vscode.window.showInformationMessage).mock.calls[1]?.[0])).toMatch(/will not start again here until you start it/);

    controller.isRunning.mockReturnValue(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Start Here' as never);
    controller.startHere.mockRejectedValueOnce(new Error('not supported in remote windows'));
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('not supported in remote windows');
  });

  it('copies a config that points at the stable shim path, without a token', async () => {
    await command('filemakerDataApiTools.copyAiMcpConfig')();
    const copied = JSON.parse(String(vi.mocked(vscode.env.clipboard.writeText).mock.calls[0]?.[0]));
    expect(copied.mcpServers.filemaker.args[0]).toBe(installedShimPath(join(dir, 'global')));
    expect(await readFile(installedShimPath(join(dir, 'global')), 'utf8')).toBe('//shim');
    expect(copied.mcpServers.filemaker.args).toContain(join(dir, 'global', 'ai-mcp'));
    const note = String(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0]);
    expect(note).toMatch(/Node\.js 18/);
    expect(note).toMatch(/model provider/);
    expect(note).toMatch(/kept up to date when the extension updates/);
  });

  it('says to copy again after an update when the stable copy could not be made', async () => {
    await rm(join(dir, 'ext', 'dist', 'aiMcpShim.js'));
    await command('filemakerDataApiTools.copyAiMcpConfig')();
    const note = String(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0]);
    expect(note).toMatch(/copy the config again after the extension updates/);
  });

  it('refuses to copy a config without an absolute storage folder', async () => {
    vi.mocked(vscode.commands.registerCommand).mockClear();
    registerAiMcpCommands({ controller, extensionPath: '/e', globalStoragePath: undefined, isEnabled: () => true, refresh: vi.fn() });
    await command('filemakerDataApiTools.copyAiMcpConfig')();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});

describe('watchExternalServerSetting', () => {
  it('tells the controller when the external-server setting changes, and ignores other settings', async () => {
    let listener: (event: { affectsConfiguration(section: string): boolean }) => unknown = () => undefined;
    const handleSettingChange = vi.fn(async () => undefined);
    watchExternalServerSetting({
      onDidChangeConfiguration: (l) => ((listener = l), { dispose() {} }),
      controller: { handleSettingChange }
    });
    listener({ affectsConfiguration: (section) => section === 'filemaker.offline' });
    expect(handleSettingChange).not.toHaveBeenCalled();
    listener({ affectsConfiguration: (section) => section === 'filemaker.ai.externalServer' });
    expect(handleSettingChange).toHaveBeenCalledTimes(1);
  });

  it('logs a failure instead of throwing', async () => {
    let listener: (event: { affectsConfiguration(section: string): boolean }) => unknown = () => undefined;
    const log = vi.fn();
    watchExternalServerSetting({
      onDidChangeConfiguration: (l) => ((listener = l), { dispose() {} }),
      controller: { handleSettingChange: async () => Promise.reject(new Error('boom')) },
      log
    });
    listener({ affectsConfiguration: () => true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
