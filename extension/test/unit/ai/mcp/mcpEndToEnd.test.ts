/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildSync } from 'esbuild';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AuditEntry } from '../../../../src/ai/aiAudit';
import { AiToolService } from '../../../../src/ai/aiToolService';
import { AiMcpServer, type McpLimits } from '../../../../src/ai/mcp/aiMcpServer';
import { newToken } from '../../../../src/ai/mcp/auth';
import { DISCOVERY_VERSION, discoveryFileName, writeDiscovery } from '../../../../src/ai/mcp/discovery';
import { getProcessStartTime } from '../../../../src/ai/mcp/processInfo';
import { createEndpoint, socketFolderName } from '../../../../src/ai/mcp/socketPath';
import { FMClient } from '../../../../src/services/fmClient';
import { SchemaService } from '../../../../src/services/schemaService';
import { SecretStore } from '../../../../src/services/secretStore';
import type { ConnectionProfile } from '../../../../src/types/fm';
import { InMemorySecretStorage } from '../../mocks';
import { makeSettings } from '../harness';

const posix = process.platform !== 'win32';
const repo = path.resolve(__dirname, '../../../..');

// The real built shim, the real MCP server on a real socket, the SDK's MCP client, the real
// AiToolService, FMClient and SchemaService, and the mock FileMaker Data API over HTTP.
let work: string;
let shimPath: string;
let mock: ChildProcess;
let mockBase = '';
let service: AiToolService;
let profile: ConnectionProfile;
let settings: ReturnType<typeof makeSettings>;
const audit: AuditEntry[] = [];
let startTime: string;

interface Window {
  server: AiMcpServer;
  token: string;
  endpoint: string;
  directory: string;
  folder: string;
  file: string;
}
const windows: Window[] = [];
const children: ChildProcess[] = [];
const clients: Client[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'fme-'));
  shimPath = join(work, 'aiMcpShim.js');
  buildSync({
    entryPoints: [join(repo, 'src/ai/mcp/shim.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: shimPath,
    logLevel: 'silent'
  });

  nock.enableNetConnect('127.0.0.1');
  const port = await freePort();
  mock = spawn(process.execPath, [join(repo, 'test/mock-server/server.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  mockBase = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${mockBase}/__admin/reset`, { method: 'POST' });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  await secrets.setPassword('p1', 'testpass1');
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const client = new FMClient(secrets, logger as never, 5000);
  const schema = new SchemaService(client, logger as never);
  profile = {
    id: 'p1',
    name: 'Mock',
    authMode: 'direct',
    serverUrl: mockBase,
    database: 'Sales',
    username: 'tester',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest',
    aiAccess: 'read'
  };
  settings = makeSettings({ allowWrites: true, allowScripts: false, readableLayouts: { p1: ['Contacts'] }, scriptAllowlist: {} });
  service = new AiToolService({
    settings: () => settings,
    featureSwitchOn: () => true,
    featureGuard: () => ({ allowed: true }),
    isTrusted: () => true,
    isOffline: () => false,
    getProfile: async () => profile,
    client,
    schema,
    ui: { confirm: async () => false, input: async () => undefined },
    audit: { record: async (entry) => void audit.push(entry) },
    now: () => Date.now()
  });
  startTime = (await getProcessStartTime(process.pid)) as string;
}, 30_000);

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const child of children.splice(0)) child.kill();
  for (const w of windows.splice(0)) {
    await w.server.stop();
    await rm(w.file, { force: true });
  }
  service.setKilled(false);
});

afterAll(async () => {
  mock?.kill();
  nock.disableNetConnect();
  await rm(work, { recursive: true, force: true });
});

async function openWindow(
  folder: string,
  options: { limits?: Partial<McpLimits>; directory?: string; token?: string; record?: Partial<Record<string, unknown>> } = {}
): Promise<Window> {
  const directory = options.directory ?? join(work, 'discovery');
  const token = newToken();
  const endpoint = (await createEndpoint({ baseDirectory: work })).path;
  const server = new AiMcpServer({ core: service, token, endpoint, serverInfo: { name: 'e2e', version: '1' }, limits: options.limits });
  await server.start();
  const file = await writeDiscovery(directory, discoveryFileName([folder], process.pid), {
    version: DISCOVERY_VERSION,
    socketPath: endpoint,
    pid: process.pid,
    startTime,
    token: options.token ?? token,
    workspaceFolders: [folder],
    label: path.basename(folder),
    created: new Date().toISOString(),
    ...(options.record as object)
  });
  const window = { server, token, endpoint, directory, folder, file };
  windows.push(window);
  return window;
}

async function connect(args: string[], env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1' });
  clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [shimPath, ...args], env: { ...process.env, ...env } as Record<string, string>, stderr: 'pipe' });
  await client.connect(transport);
  return client;
}

function runShim(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [shimPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (data) => (stdout += data));
  child.stderr?.on('data', (data) => (stderr += data));
  return new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout, stderr, child })));
}

const text = (result: any): string => String(result.content?.[0]?.text ?? '');

describe('MCP end to end (real shim, real socket, SDK client)', () => {
  it('initializes, lists exactly what the core offers with annotations, and calls a read tool through the mock FileMaker server', async () => {
    const window = await openWindow(join(work, 'alpha'));
    const client = await connect(['--dir', window.directory]);
    expect(client.getServerVersion()).toMatchObject({ name: 'e2e' });
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(service.listTools().map((tool) => tool.name).sort());
    expect(tools.find((tool) => tool.name === 'fm_find_records')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((tool) => tool.name === 'fm_delete_record')?.annotations).toMatchObject({ destructiveHint: true });

    const layouts = await client.callTool({ name: 'fm_list_layouts', arguments: {} });
    expect(layouts.isError).toBe(false);
    expect(text(layouts)).toContain('Contacts');

    const found = await client.callTool({ name: 'fm_find_records', arguments: { layout: 'Contacts', requests: [{ fields: { Status: '==Closed' } }], limit: 2 } });
    const body = JSON.parse(text(found));
    expect(body.records).toHaveLength(2);
    expect(body.foundCount).toBeGreaterThan(40);
    expect(text(found)).not.toContain(mockBase);
    expect(audit.at(-1)).toMatchObject({ tool: 'fm_find_records', client: 'e2e 1', outcome: 'ok' });
  });

  it('refuses a write on a read-only connection and leaves the data alone', async () => {
    const window = await openWindow(join(work, 'alpha'));
    const client = await connect(['--dir', window.directory]);
    const result = await client.callTool({ name: 'fm_edit_record', arguments: { layout: 'Contacts', recordId: '1001', fields: { Region: 'Moon' } } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/reads only/);
    const read = await client.callTool({ name: 'fm_get_record', arguments: { layout: 'Contacts', recordId: '1001' } });
    expect(text(read)).not.toContain('Moon');
  });

  it('applies the kill switch: it sends list_changed, lists nothing, and refuses calls', async () => {
    const window = await openWindow(join(work, 'alpha'));
    const client = await connect(['--dir', window.directory]);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void (changed += 1));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    service.setKilled(true);
    window.server.notifyIfToolsChanged();
    for (let i = 0; i < 50 && changed === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changed).toBe(1);
    expect((await client.listTools()).tools).toEqual([]);
    const refused = await client.callTool({ name: 'fm_list_layouts', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/switched off/);

    service.setKilled(false);
    window.server.notifyIfToolsChanged();
    for (let i = 0; i < 50 && changed < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changed).toBe(2);
  });

  it('does not connect when the discovery token is wrong, and says only that it was refused', async () => {
    const window = await openWindow(join(work, 'alpha'), { token: newToken() });
    const result = await runShim(['--dir', window.directory]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/refused/);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(window.token);
  });

  it('does not use a discovery file whose process is gone or is a different run, and never connects to its socket', async () => {
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((resolve) => dead.once('exit', resolve));
    const directory = join(work, 'stale');
    // A server listening on the socket the stale files name: it must see no connection.
    let attempts = 0;
    const endpoint = (await createEndpoint({ baseDirectory: work })).path;
    const decoy = net.createServer(() => void (attempts += 1));
    await new Promise<void>((resolve) => decoy.listen(endpoint, resolve));
    try {
      const base = { version: DISCOVERY_VERSION as 1, socketPath: endpoint, token: newToken(), workspaceFolders: ['/w'], label: 'w', created: 'x' };
      await writeDiscovery(directory, 'dead.json', { ...base, pid: dead.pid as number, startTime });
      await writeDiscovery(directory, 'reused.json', { ...base, pid: process.pid, startTime: 'not-the-start-time' });
      const result = await runShim(['--dir', directory]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/No VS Code window is running/);
      expect(attempts).toBe(0);
    } finally {
      decoy.close();
    }
  });

  it('with two live windows it refuses to guess, lists them on stderr, and connects to the named one', async () => {
    const alpha = await openWindow(join(work, 'alpha'));
    await openWindow(join(work, 'beta'));
    const ambiguous = await runShim(['--dir', alpha.directory]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toMatch(/not guessing/);
    expect(ambiguous.stderr).toContain('alpha');
    expect(ambiguous.stderr).toContain('beta');
    expect(ambiguous.stdout).toBe('');

    const client = await connect(['--dir', alpha.directory, '--workspace', 'beta']);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const viaEnv = await connect(['--dir', alpha.directory], { FM_AI_WORKSPACE: join(work, 'alpha') });
    expect((await viaEnv.listTools()).tools.length).toBeGreaterThan(0);
  });

  it.skipIf(!posix)('refuses a discovery folder or file that other users can read', async () => {
    const directory = join(work, 'loose');
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    const result = await runShim(['--dir', directory]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/cannot use the discovery folder/);

    const open = await openWindow(join(work, 'gamma'), { directory: join(work, 'file-check') });
    await chmod(open.file, 0o644);
    const second = await runShim(['--dir', open.directory]);
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/ignoring/);
  });

  it.skipIf(!posix)('listens on a 0600 socket in a 0700 folder', async () => {
    const window = await openWindow(join(work, 'alpha'));
    expect((await stat(window.endpoint)).mode & 0o777).toBe(0o600);
    expect((await stat(window.endpoint.slice(0, window.endpoint.lastIndexOf('/')))).mode & 0o777).toBe(0o700);
  });

  it('closes the connection on an oversized message and the shim ends', async () => {
    const window = await openWindow(join(work, 'alpha'), { limits: { maxMessageBytes: 4096 } });
    const child = spawn(process.execPath, [shimPath, '--dir', window.directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '';
    child.stdout?.on('data', (data) => (stdout += data));
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin?.write(`{"pad":"${'x'.repeat(10_000)}"}\n`);
    await exited;
    expect(stdout).toContain('Message too large');
  });

  it('accepts only maxConnections shims at once; the others end with a refusal', async () => {
    const window = await openWindow(join(work, 'alpha'), { limits: { maxConnections: 3 } });
    const results: ChildProcess[] = [];
    for (let i = 0; i < 5; i += 1) {
      const child = spawn(process.execPath, [shimPath, '--dir', window.directory], { stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      results.push(child);
    }
    await expect.poll(() => ({
      running: results.filter((child) => child.exitCode === null).length,
      refused: results.filter((child) => child.exitCode === 1).length,
      connected: window.server.connectionCount()
    }), { timeout: 30_000, interval: 100 }).toEqual({ running: 3, refused: 2, connected: 3 });
  }, 60_000);

  it('cleans up an idle connection: the shim ends and the server forgets it', async () => {
    const window = await openWindow(join(work, 'alpha'), { limits: { idleTimeoutMs: 300 } });
    const child = spawn(process.execPath, [shimPath, '--dir', window.directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.server.connectionCount()).toBe(0);
  });

  it('shuts down cleanly: stopping the server ends the shim with 0 and the client sees the close', async () => {
    const window = await openWindow(join(work, 'alpha'));
    const client = await connect(['--dir', window.directory]);
    let closed = false;
    client.onclose = () => void (closed = true);
    await window.server.stop();
    for (let i = 0; i < 100 && !closed; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(true);
    const child = spawn(process.execPath, [shimPath, '--dir', window.directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(1); // nothing is listening any more
  });

  it('does not use a discovery file that names a socket this extension would not create, and never connects to it', async () => {
    const directory = join(work, 'evil');
    let attempts = 0;
    // A Unix socket in a temp folder, or on Windows (where `listen` on a file path is refused) a pipe
    // whose name is not one the extension creates.
    const decoyPath = posix ? join(work, 'decoy.sock') : `\\\\.\\pipe\\decoy-${newToken().slice(0, 16)}`;
    const decoy = net.createServer(() => void (attempts += 1));
    await new Promise<void>((resolve) => decoy.listen(decoyPath, resolve));
    try {
      await writeDiscovery(directory, 'evil.json', {
        version: DISCOVERY_VERSION as 1,
        socketPath: decoyPath,
        pid: process.pid,
        startTime,
        token: newToken(),
        workspaceFolders: ['/w'],
        label: 'evil',
        created: 'x'
      });
      const result = await runShim(['--dir', directory]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/ignoring .*would not create/);
      expect(attempts).toBe(0);
    } finally {
      decoy.close();
    }
  });

  it.skipIf(!posix)('will not connect to a path that is not a socket, even one named as the extension names its sockets', async () => {
    const uid = process.getuid?.() ?? 0;
    const folder = join(work, socketFolderName(uid, 'plain-file'));
    await mkdir(folder, { mode: 0o700 });
    const plain = join(folder, 'abcdef012345.sock');
    const { writeFile } = await import('fs/promises');
    await writeFile(plain, 'not a socket');
    const directory = join(work, 'plain-file-disc');
    await writeDiscovery(directory, 'plain.json', {
      version: DISCOVERY_VERSION as 1,
      socketPath: plain,
      pid: process.pid,
      startTime,
      token: newToken(),
      workspaceFolders: ['/w'],
      label: 'plain',
      created: 'x'
    });
    const result = await runShim(['--dir', directory]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/will not connect: .*not a socket/);
    expect(result.stdout).toBe('');
  });

  it.skipIf(!posix)('will not connect to a socket in a folder other users can use', async () => {
    const uid = process.getuid?.() ?? 0;
    const folder = join(work, socketFolderName(uid, 'open-folder'));
    await mkdir(folder, { mode: 0o755 });
    await chmod(folder, 0o755);
    const path = join(folder, 'abcdef012345.sock');
    let attempts = 0;
    const server = net.createServer(() => void (attempts += 1));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const directory = join(work, 'open-folder-disc');
      await writeDiscovery(directory, 'open.json', {
        version: DISCOVERY_VERSION as 1,
        socketPath: path,
        pid: process.pid,
        startTime,
        token: newToken(),
        workspaceFolders: ['/w'],
        label: 'open',
        created: 'x'
      });
      const result = await runShim(['--dir', directory]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/will not connect: .*accessible by other users/);
      expect(attempts).toBe(0);
    } finally {
      server.close();
    }
  });

  it('never prints control characters from a workspace argument or a label to stderr', async () => {
    const alpha = await openWindow(join(work, 'alpha'));
    await openWindow(join(work, 'beta'));
    const result = await runShim(['--dir', alpha.directory, '--workspace', 'x\u001b[31mred\u0007']);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('\u001b');
    expect(result.stderr).not.toContain('\u0007');
    expect(result.stderr).toContain('x?[31mred?');
  });

  it('reports a missing --dir on stderr and writes nothing to stdout', async () => {
    const result = await runShim([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/missing --dir/);
    expect(result.stdout).toBe('');
  });
});
