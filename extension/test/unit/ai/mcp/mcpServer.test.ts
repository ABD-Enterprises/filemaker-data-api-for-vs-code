/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_TOOL_DEFINITIONS } from '../../../../src/ai/aiToolDefinitions';
import { AiToolError } from '../../../../src/ai/aiToolService';
import { AiMcpServer, SUPPORTED_PROTOCOL_VERSIONS, type McpLimits, type McpToolCore } from '../../../../src/ai/mcp/aiMcpServer';
import { newToken } from '../../../../src/ai/mcp/auth';
import { createEndpoint } from '../../../../src/ai/mcp/socketPath';
import { RawClient } from './mcpClientHelper';

const posix = process.platform !== 'win32';

describe('AiMcpServer', () => {
  let base: string;
  let token: string;
  let server: AiMcpServer;
  let endpoint: string;
  let tools: typeof AI_TOOL_DEFINITIONS;
  let core: McpToolCore & { invoke: ReturnType<typeof vi.fn> };
  const clients: RawClient[] = [];

  async function start(limits: Partial<McpLimits> = {}) {
    endpoint = (await createEndpoint({ baseDirectory: base })).path;
    server = new AiMcpServer({ core, token, endpoint, serverInfo: { name: 'test', version: '1' }, limits });
    await server.start();
  }

  async function client(authenticate = true): Promise<RawClient> {
    const c = await RawClient.connect(endpoint);
    clients.push(c);
    if (authenticate) expect(await c.hello(token)).toBe('{"hello":"ok"}');
    return c;
  }

  async function initialized(extra: Record<string, unknown> = {}): Promise<RawClient> {
    const c = await client();
    c.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claimer', version: '9' }, ...extra } });
    await c.json();
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return c;
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'fm-ai-srv-'));
    token = newToken();
    tools = AI_TOOL_DEFINITIONS.filter((tool) => tool.kind === 'read');
    core = { listTools: () => tools, invoke: vi.fn(async () => ({ ok: true })) } as never;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server?.stop();
    await rm(base, { recursive: true, force: true });
  });

  describe('authentication', () => {
    it('answers a correct hello and nothing else is accepted first', async () => {
      await start();
      await client();
      expect(server.connectionCount()).toBe(1);
    });

    it('closes without a word on a wrong token, a missing hello, junk, or a JSON-RPC message first', async () => {
      await start();
      for (const first of [
        `{"hello":{"protocol":1,"token":"${newToken()}"}}\n`,
        `{"hello":{"protocol":1,"token":""}}\n`,
        '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
        'garbage\n',
        '[]\n'
      ]) {
        const c = await client(false);
        c.write(first);
        expect(await c.next(), first.slice(0, 40)).toBe('<closed>');
      }
      expect(core.invoke).not.toHaveBeenCalled();
    });

    it.skipIf(!posix)('never serves a request before the hello, even if sent in the same write', async () => {
      await start();
      const c = await client(false);
      c.write(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n`);
      expect(await c.next()).toBe('<closed>');
    });

    it('closes a connection that never says hello', async () => {
      await start({ helloTimeoutMs: 80 });
      const c = await client(false);
      expect(await c.waitClosed(1500)).toBe(true);
    });

    it('accepts a hello followed by a request in one write', async () => {
      await start();
      const c = await client(false);
      c.write(`${JSON.stringify({ hello: { protocol: 1, token } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
      expect(await c.next()).toBe('{"hello":"ok"}');
      await c.json();
    });
  });

  describe('MCP protocol', () => {
    it('initializes with negotiated version, tools capability with listChanged, server info', async () => {
      await start();
      const c = await client();
      c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'x' } } });
      const reply = await c.json();
      expect(reply).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'test' } } });
      expect(reply.result.instructions).toMatch(/untrusted/);

      c.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
      expect((await c.json()).result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    });

    it('answers ping, and refuses other requests before initialize', async () => {
      await start();
      const c = await client();
      c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect((await c.json()).result).toEqual({});
      c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect((await c.json()).error.code).toBe(-32002);
      c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      expect((await c.json()).error.code).toBe(-32002);
      expect(core.invoke).not.toHaveBeenCalled();
    });

    it('lists exactly what the core offers, with annotations', async () => {
      tools = AI_TOOL_DEFINITIONS.slice();
      await start();
      const c = await initialized();
      c.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
      const list = (await c.json()).result.tools as any[];
      expect(list.map((tool) => tool.name).sort()).toEqual(AI_TOOL_DEFINITIONS.map((tool) => tool.name).sort());
      const byName = (name: string) => list.find((tool) => tool.name === name);
      expect(byName('fm_find_records').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(byName('fm_delete_record').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName('fm_edit_record').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName('fm_create_record').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(byName('fm_run_script').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName('fm_find_records').inputSchema.additionalProperties).toBe(false);

      tools = [];
      c.send({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
      expect((await c.json()).result.tools).toEqual([]);
    });

    it('passes tools/call to the core unchanged, with the claimed client name, and returns text content', async () => {
      await start();
      const c = await initialized();
      core.invoke.mockResolvedValueOnce({ layouts: [{ name: 'Contacts' }] });
      c.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fm_list_layouts', arguments: { extra: 1 } } });
      const reply = await c.json();
      expect(reply.result).toEqual({ content: [{ type: 'text', text: '{"layouts":[{"name":"Contacts"}]}' }], isError: false });
      expect(core.invoke).toHaveBeenCalledWith('fm_list_layouts', { extra: 1 }, expect.objectContaining({ client: 'Claimer 9', signal: expect.anything() }));
    });

    it('turns a core refusal into an isError result with the core\'s message, and anything else into a generic one', async () => {
      await start();
      const c = await initialized();
      core.invoke.mockRejectedValueOnce(new AiToolError('AI tools are off.'));
      c.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'fm_edit_record', arguments: {} } });
      expect((await c.json()).result).toEqual({ content: [{ type: 'text', text: 'AI tools are off.' }], isError: true });
      core.invoke.mockRejectedValueOnce(new Error('secret-host.example.com exploded'));
      c.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      const generic = await c.json();
      expect(generic.result.isError).toBe(true);
      expect(JSON.stringify(generic)).not.toContain('secret-host');
    });

    it('rejects an unknown tool name as a protocol error without calling the core, and defaults missing arguments', async () => {
      await start();
      const c = await initialized();
      c.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'fm_drop_database' } });
      expect((await c.json()).error.code).toBe(-32602);
      c.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: {} });
      expect((await c.json()).error.code).toBe(-32602);
      expect(core.invoke).not.toHaveBeenCalled();
      c.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      await c.json();
      expect(core.invoke).toHaveBeenCalledWith('fm_list_layouts', {}, expect.anything());
    });

    it('handles malformed input: parse errors, batches, bad ids, unknown methods; ignores unknown notifications', async () => {
      await start();
      const c = await initialized();
      c.write('{not json\n');
      expect((await c.json()).error.code).toBe(-32700);
      c.write('[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n');
      expect((await c.json()).error.code).toBe(-32600);
      c.write('"text"\n');
      expect((await c.json()).error.code).toBe(-32700);
      c.send({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' });
      expect((await c.json()).error.code).toBe(-32600);
      c.send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
      expect((await c.json()).error.code).toBe(-32601);
      c.send({ jsonrpc: '2.0', method: 'notifications/unknown' });
      c.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
      expect((await c.json()).id).toBe(4);
    });

    it('aborts a call on notifications/cancelled and sends no reply for it', async () => {
      await start();
      const c = await initialized();
      let signal: AbortSignal | undefined;
      core.invoke.mockImplementationOnce(async (_n: string, _i: unknown, ctx: { signal: AbortSignal }) => {
        signal = ctx.signal;
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
        throw new AiToolError('cancelled');
      });
      c.send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 20 } });
      c.send({ jsonrpc: '2.0', id: 21, method: 'ping' });
      expect((await c.json()).id).toBe(21);
      expect(signal?.aborted).toBe(true);
    });

    it('aborts in-flight calls when the connection drops', async () => {
      await start();
      const c = await initialized();
      let signal: AbortSignal | undefined;
      core.invoke.mockImplementationOnce(async (_n: string, _i: unknown, ctx: { signal: AbortSignal }) => {
        signal = ctx.signal;
        await new Promise(() => undefined);
      });
      c.send({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      c.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(signal?.aborted).toBe(true);
    });

    it('limits calls in flight per connection', async () => {
      await start({ maxInFlightPerConnection: 2 });
      const c = await initialized();
      core.invoke.mockImplementation(() => new Promise(() => undefined));
      for (let id = 30; id < 33; id += 1) c.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fm_list_layouts' } });
      const reply = await c.json();
      expect(reply).toMatchObject({ id: 32, error: { code: -32000 } });
    });
  });

  describe('list_changed', () => {
    it('notifies initialized clients only when the offered tools change', async () => {
      await start();
      const c = await initialized();
      const other = await client();
      server.notifyIfToolsChanged();
      expect(await c.next(200)).toBe('<timeout>');
      tools = [];
      server.notifyIfToolsChanged();
      expect(await c.json()).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      expect(await other.next(200)).toBe('<timeout>'); // never initialized
      server.notifyIfToolsChanged();
      expect(await c.next(200)).toBe('<timeout>');
      tools = AI_TOOL_DEFINITIONS.filter((tool) => tool.kind === 'read');
      server.notifyIfToolsChanged();
      expect((await c.json()).method).toBe('notifications/tools/list_changed');
    });
  });

  describe('limits', () => {
    it('closes a connection that sends an oversized message, telling an authenticated client why', async () => {
      await start({ maxMessageBytes: 2000 });
      const c = await initialized();
      c.write(`{"pad":"${'x'.repeat(3000)}"}\n`);
      expect((await c.json()).error.message).toMatch(/too large/);
      expect(await c.waitClosed()).toBe(true);
    });

    it('closes an oversized message from an unauthenticated peer silently', async () => {
      await start({ maxMessageBytes: 2000 });
      const c = await client(false);
      c.write('x'.repeat(5000));
      expect(await c.next()).toBe('<closed>');
    });

    it('limits requests per minute per connection and keeps the connection', async () => {
      await start({ requestsPerMinute: 3 });
      const c = await initialized();
      for (let id = 40; id < 46; id += 1) c.send({ jsonrpc: '2.0', id, method: 'ping' });
      const replies = [];
      for (let i = 0; i < 6; i += 1) replies.push(await c.json());
      expect(replies.filter((reply) => reply.error?.message === 'Rate limit exceeded.').length).toBeGreaterThanOrEqual(2);
      expect(c.closed).toBe(false);
      const second = await initialized();
      second.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect((await second.json()).result).toBeDefined();
    });

    it('accepts at most maxConnections connections at a time and recovers when one closes', async () => {
      await start({ maxConnections: 3 });
      const accepted: RawClient[] = [];
      for (let i = 0; i < 3; i += 1) accepted.push(await client());
      const extra = await RawClient.connect(endpoint);
      clients.push(extra);
      extra.write(`${JSON.stringify({ hello: { protocol: 1, token } })}\n`);
      expect(await extra.next()).toBe('<closed>');
      expect(server.connectionCount()).toBe(3);
      accepted[0]?.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client();
    });

    it('closes idle connections and forgets them', async () => {
      await start({ idleTimeoutMs: 100 });
      const c = await client();
      expect(await c.waitClosed(1500)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.connectionCount()).toBe(0);
    });
  });

  describe('lifecycle', () => {
    it.skipIf(!posix)('creates the socket with mode 0600 in a 0700 folder', async () => {
      await start();
      expect((await stat(endpoint)).mode & 0o777).toBe(0o600);
      expect((await stat(endpoint.slice(0, endpoint.lastIndexOf('/')))).mode & 0o777).toBe(0o700);
    });

    it('stop closes every connection, stops listening and removes the socket', async () => {
      await start();
      const a = await client();
      const b = await initialized();
      await server.stop();
      expect(await a.waitClosed()).toBe(true);
      expect(await b.waitClosed()).toBe(true);
      expect(server.isRunning()).toBe(false);
      await expect(RawClient.connect(endpoint)).rejects.toThrow();
      if (posix) await expect(stat(endpoint)).rejects.toThrow();
    });

    it('cannot be started twice', async () => {
      await start();
      await expect(server.start()).rejects.toThrow(/already running/);
    });
  });
});
