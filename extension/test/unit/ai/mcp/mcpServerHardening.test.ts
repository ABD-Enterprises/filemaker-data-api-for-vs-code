import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_TOOL_DEFINITIONS } from '../../../../src/ai/aiToolDefinitions';
import { AiToolError } from '../../../../src/ai/aiToolService';
import { AiMcpServer, DEFAULT_MCP_LIMITS, type McpLimits, type McpToolCore } from '../../../../src/ai/mcp/aiMcpServer';
import { newToken } from '../../../../src/ai/mcp/auth';
import { createEndpoint } from '../../../../src/ai/mcp/socketPath';
import { RawClient } from './mcpClientHelper';

const posix = process.platform !== 'win32';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AiMcpServer hardening', () => {
  let base: string;
  let token: string;
  let server: AiMcpServer;
  let endpoint: string;
  let core: McpToolCore & { invoke: ReturnType<typeof vi.fn> };
  const clients: RawClient[] = [];
  const events: Array<{ type: string; count: number }> = [];

  async function start(limits: Partial<McpLimits> = {}, extra: Record<string, unknown> = {}) {
    endpoint = (await createEndpoint({ baseDirectory: base })).path;
    server = new AiMcpServer({
      core,
      token,
      endpoint,
      serverInfo: { name: 'test', version: '1' },
      limits,
      onConnectionChange: (event) => events.push(event),
      ...extra
    });
    await server.start();
  }
  async function client(authenticate = true): Promise<RawClient> {
    const c = await RawClient.connect(endpoint);
    clients.push(c);
    if (authenticate) expect(await c.hello(token)).toBe('{"hello":"ok"}');
    return c;
  }
  async function initialized(): Promise<RawClient> {
    const c = await client();
    c.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'x' } } });
    await c.json();
    return c;
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'fm-ai-srvh-'));
    token = newToken();
    events.length = 0;
    core = { listTools: () => AI_TOOL_DEFINITIONS.filter((t) => t.kind === 'read'), invoke: vi.fn(async () => ({ ok: true })) } as never;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server?.stop();
    await rm(base, { recursive: true, force: true });
  });

  it('uses a short hello timeout and a small allowance for connections that have not authenticated', () => {
    expect(DEFAULT_MCP_LIMITS.helloTimeoutMs).toBeLessThanOrEqual(1000);
    expect(DEFAULT_MCP_LIMITS.maxUnauthenticated).toBeLessThanOrEqual(2);
  });

  describe('connections that never authenticate', () => {
    it('eight silent connections do not keep a legitimate client out (the oldest silent one is dropped)', async () => {
      await start({ helloTimeoutMs: 5000 });
      const silent: RawClient[] = [];
      for (let i = 0; i < 8; i += 1) {
        silent.push(await RawClient.connect(endpoint));
        clients.push(silent[i] as RawClient);
      }
      await wait(50);
      expect(silent.filter((c) => !c.closed)).toHaveLength(2);
      const legitimate = await client();
      legitimate.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect((await legitimate.json()).result).toEqual({});
    });

    it('silent connections do not count against the authenticated allowance', async () => {
      await start({ maxConnections: 3, helloTimeoutMs: 5000 });
      const authed = [await client(), await client(), await client()];
      const silent = [await RawClient.connect(endpoint), await RawClient.connect(endpoint)];
      clients.push(...silent);
      await wait(50);
      expect(server.connectionCount()).toBe(3);
      expect(authed.every((c) => !c.closed)).toBe(true);
      expect(silent.every((c) => !c.closed)).toBe(true);
    });

    it('a silent connection is dropped after the hello timeout', async () => {
      await start({ helloTimeoutMs: 100 });
      const silent = await RawClient.connect(endpoint);
      clients.push(silent);
      expect(await silent.waitClosed(1500)).toBe(true);
    });
  });

  describe('idle timeout', () => {
    it('does not close a connection while a call is in flight, and closes it once it is idle', async () => {
      await start({ idleTimeoutMs: 100 });
      const c = await initialized();
      core.invoke.mockImplementationOnce(async () => {
        await wait(400);
        return { done: true };
      });
      c.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      const reply = await c.json(3000);
      expect(reply.result.isError).toBe(false);
      expect(c.closed).toBe(false);
      expect(await c.waitClosed(1500)).toBe(true);
    });
  });

  describe('floods', () => {
    it('closes a connection that sends more bytes per second than allowed, before parsing', async () => {
      await start({ maxBytesPerSecond: 5000, maxMessageBytes: 4000 });
      const c = await initialized();
      for (let i = 0; i < 4; i += 1) c.write(`${JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'ping', params: { pad: 'x'.repeat(2500) } })}\n`);
      expect(await c.waitClosed()).toBe(true);
    });

    it('closes a client that does not read once too much is waiting to be written', async () => {
      await start({ maxWriteBacklogBytes: 200_000 });
      const c = await initialized();
      core.invoke.mockImplementation(async () => ({ big: 'y'.repeat(400_000) }));
      c.socket.pause();
      for (let i = 0; i < 6; i += 1) {
        c.send({ jsonrpc: '2.0', id: 200 + i, method: 'tools/call', params: { name: 'fm_list_layouts' } });
        await wait(30);
      }
      await wait(200);
      expect(server.connectionCount()).toBe(0);
    });

    it('lets a client that reads keep receiving large results', async () => {
      await start({ maxWriteBacklogBytes: 200_000 });
      const c = await initialized();
      core.invoke.mockImplementation(async () => ({ big: 'y'.repeat(400_000) }));
      for (let i = 0; i < 3; i += 1) {
        c.send({ jsonrpc: '2.0', id: 300 + i, method: 'tools/call', params: { name: 'fm_list_layouts' } });
        expect((await c.json(5000)).result.isError).toBe(false);
      }
    });
  });

  describe('cancellation', () => {
    it('sends no reply at all for a call that was cancelled, even if the core then returns or throws', async () => {
      await start();
      const c = await initialized();
      let release: () => void = () => undefined;
      core.invoke.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { late: true };
      });
      c.send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      await wait(50);
      c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 20 } });
      await wait(50);
      release();
      await wait(100);
      c.send({ jsonrpc: '2.0', id: 21, method: 'ping' });
      expect((await c.json()).id).toBe(21);
      expect(c.lines).toEqual([]);

      core.invoke.mockImplementationOnce(async (_n: string, _i: unknown, ctx: { signal: AbortSignal }) => {
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
        throw new AiToolError('cancelled');
      });
      c.send({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      await wait(50);
      c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 22 } });
      await wait(100);
      c.send({ jsonrpc: '2.0', id: 23, method: 'ping' });
      expect((await c.json()).id).toBe(23);
      expect(c.lines).toEqual([]);
    });
  });

  describe('socket mode', () => {
    it.skipIf(!posix)('does not serve a socket it could not make owner-only: it closes and rejects', async () => {
      endpoint = (await createEndpoint({ baseDirectory: base })).path;
      const failing = new AiMcpServer({
        core,
        token,
        endpoint,
        serverInfo: { name: 't', version: '1' },
        chmodSocket: async () => {
          throw new Error('EPERM');
        }
      });
      await expect(failing.start()).rejects.toThrow(/Could not restrict the socket/);
      expect(failing.isRunning()).toBe(false);
      await expect(RawClient.connect(endpoint)).rejects.toThrow();
      await expect(stat(endpoint)).rejects.toThrow();
    });
  });

  describe('connection events', () => {
    it('reports authenticated connections opening and closing, not silent ones', async () => {
      await start();
      const silent = await RawClient.connect(endpoint);
      clients.push(silent);
      const a = await client();
      expect(events).toEqual([{ type: 'connected', count: 1 }]);
      a.close();
      await wait(100);
      expect(events).toEqual([
        { type: 'connected', count: 1 },
        { type: 'disconnected', count: 0 }
      ]);
    });
  });
});
