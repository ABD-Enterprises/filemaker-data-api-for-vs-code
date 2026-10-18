/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { AI_TOOL_DEFINITIONS } from '../../../../src/ai/aiToolDefinitions';
import { AiMcpController } from '../../../../src/ai/mcp/aiMcpController';
import { DISCOVERY_VERSION, parseDiscovery, writeDiscovery } from '../../../../src/ai/mcp/discovery';
import { buildMcpConfig, discoveryDirectory } from '../../../../src/ai/mcp/mcpConfig';
import { newToken } from '../../../../src/ai/mcp/auth';
import { getProcessStartTime } from '../../../../src/ai/mcp/processInfo';
import { registerAiMcpCommands } from '../../../../src/commands/aiMcp';
import { RawClient } from './mcpClientHelper';

const posix = process.platform !== 'win32';

describe('AiMcpController', () => {
  let storage: string;
  let enabled: boolean;
  let remote: string | undefined;
  let controller: AiMcpController;
  const core = { listTools: () => AI_TOOL_DEFINITIONS.filter((t) => t.kind === 'read'), invoke: vi.fn(async () => ({})) };

  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'fm-ai-ctl-'));
    enabled = true;
    remote = undefined;
    controller = new AiMcpController({
      core: core as never,
      globalStoragePath: storage,
      serverInfo: { name: 'x', version: '1' },
      isEnabled: () => enabled,
      remoteName: () => remote,
      workspaceFolders: () => ['/work/alpha'],
      log: () => undefined
    });
  });

  afterEach(async () => {
    await controller.stop();
    await rm(storage, { recursive: true, force: true });
  });

  const files = async () => (await readdir(discoveryDirectory(storage)).catch(() => [])).filter((name) => name.endsWith('.json'));

  it('is off until started, and refuses to start when the user setting is off', async () => {
    expect(controller.isRunning()).toBe(false);
    enabled = false;
    await expect(controller.start()).rejects.toThrow(/externalServer\.enabled/);
    expect(await files()).toEqual([]);
  });

  it('refuses to start in a remote window', async () => {
    for (const name of ['dev-container', 'codespaces', 'ssh-remote', 'wsl']) {
      remote = name;
      await expect(controller.start()).rejects.toThrow(/not supported in remote windows/);
    }
    expect(controller.isRunning()).toBe(false);
    expect(await files()).toEqual([]);
  });

  it('start writes a 0600 discovery file with this process\'s identity, and a client can connect with its token', async () => {
    await controller.start();
    expect(controller.isRunning()).toBe(true);
    const [name] = await files();
    const file = join(discoveryDirectory(storage), name as string);
    const record = parseDiscovery(await readFile(file, 'utf8'))!;
    expect(record).toMatchObject({ version: DISCOVERY_VERSION, pid: process.pid, workspaceFolders: ['/work/alpha'] });
    expect(record.startTime).toBe(await getProcessStartTime(process.pid));
    expect(record.token).toMatch(/^[0-9a-f]{64}$/);
    if (posix) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(discoveryDirectory(storage))).mode & 0o777).toBe(0o700);
      expect((await stat(record.socketPath)).mode & 0o777).toBe(0o600);
    }
    const client = await RawClient.connect(record.socketPath);
    expect(await client.hello(record.token)).toBe('{"hello":"ok"}');
    expect(controller.connectionCount()).toBe(1);
    client.close();
  });

  it('keeps the token out of every place but the discovery file', async () => {
    await controller.start();
    const [name] = await files();
    const record = parseDiscovery(await readFile(join(discoveryDirectory(storage), name as string), 'utf8'))!;
    const config = JSON.stringify(buildMcpConfig({ shimPath: '/ext/dist/aiMcpShim.js', discoveryDir: discoveryDirectory(storage), workspaceFolder: '/work/alpha' }));
    expect(config).not.toContain(record.token);
    expect(record.socketPath).not.toContain(storage); // the socket is not in the long global-storage path
  });

  it('stop removes the discovery file, closes connections and the socket; starting twice does nothing', async () => {
    await controller.start();
    await controller.start();
    expect(await files()).toHaveLength(1);
    const [name] = await files();
    const record = parseDiscovery(await readFile(join(discoveryDirectory(storage), name as string), 'utf8'))!;
    const client = await RawClient.connect(record.socketPath);
    await client.hello(record.token);
    await controller.stop();
    expect(await client.waitClosed()).toBe(true);
    expect(await files()).toEqual([]);
    if (posix) await expect(stat(record.socketPath)).rejects.toThrow();
    expect(controller.isRunning()).toBe(false);
    await controller.stop();
  });

  it('removes discovery files of processes that are gone when it starts, and leaves live ones', async () => {
    const directory = discoveryDirectory(storage);
    await writeDiscovery(directory, 'dead.json', {
      version: DISCOVERY_VERSION,
      socketPath: '/tmp/none.sock',
      pid: 2_147_483_000,
      startTime: 'x',
      token: newToken(),
      workspaceFolders: [],
      label: 'dead',
      created: 'x'
    });
    await controller.start();
    expect(await files()).not.toContain('dead.json');
    expect(await files()).toHaveLength(1);
  });

  it('forwards tool-list changes only to the server it owns', async () => {
    await controller.start();
    expect(() => controller.notifyToolsChanged()).not.toThrow();
    await controller.stop();
    expect(() => controller.notifyToolsChanged()).not.toThrow();
  });
});

describe('buildMcpConfig', () => {
  it('names node, the bundled shim, the discovery folder and the workspace', () => {
    expect(buildMcpConfig({ shimPath: '/e/dist/aiMcpShim.js', discoveryDir: '/g/ai-mcp', workspaceFolder: '/w' })).toEqual({
      mcpServers: { filemaker: { command: 'node', args: ['/e/dist/aiMcpShim.js', '--dir', '/g/ai-mcp', '--workspace', '/w'] } }
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

  beforeEach(() => {
    vi.clearAllMocks();
    enabled = false;
    update = vi.fn(async () => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ update, get: vi.fn(), inspect: vi.fn() } as never);
    (vscode as any).ConfigurationTarget.Global = 1;
    controller = { isRunning: vi.fn(() => false), start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    registerAiMcpCommands({ controller, extensionPath: '/ext', globalStoragePath: '/global', isEnabled: () => enabled, refresh: vi.fn() });
  });

  it('asks in a modal before turning the setting on from the command, and does nothing if declined', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(update).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[1]).toMatchObject({ modal: true });

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Turn On and Start' as never);
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(update).toHaveBeenCalledWith('ai.externalServer.enabled', true, 1);
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it('starts without a prompt when the setting is already on, stops when running, and reports errors', async () => {
    enabled = true;
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(controller.start).toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

    controller.isRunning.mockReturnValue(true);
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(controller.stop).toHaveBeenCalled();

    controller.isRunning.mockReturnValue(false);
    controller.start.mockRejectedValueOnce(new Error('not supported in remote windows'));
    await command('filemakerDataApiTools.toggleAiServer')();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('not supported in remote windows');
  });

  it('copies a ready-to-paste config without a token and mentions Node and the model provider', async () => {
    await command('filemakerDataApiTools.copyAiMcpConfig')();
    const copied = JSON.parse(String(vi.mocked(vscode.env.clipboard.writeText).mock.calls[0]?.[0]));
    expect(copied.mcpServers.filemaker.command).toBe('node');
    expect(copied.mcpServers.filemaker.args[0]).toBe(join('/ext', 'dist', 'aiMcpShim.js'));
    expect(copied.mcpServers.filemaker.args).toContain(join('/global', 'ai-mcp'));
    const note = String(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0]);
    expect(note).toMatch(/Node\.js 18/);
    expect(note).toMatch(/model provider/);
  });
});
