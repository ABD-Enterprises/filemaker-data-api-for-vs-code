import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiMcpServer } from '../../../../src/ai/mcp/aiMcpServer';
import { AI_TOOL_DEFINITIONS } from '../../../../src/ai/aiToolDefinitions';
import { AiToolError } from '../../../../src/ai/aiToolService';

// Feed the transport's socket callbacks in memory; no OS socket or listening port.
class MemorySocket extends EventEmitter {
  writable = true;
  writableLength = 0;
  replies: Array<Record<string, unknown>> = [];
  setNoDelay = vi.fn();
  setTimeout = vi.fn();
  write(line: string) { this.replies.push(JSON.parse(line)); return true; }
  destroy() { this.writable = false; this.emit('close'); }
  end() { this.writable = false; }
  send(message: unknown) { this.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); }
}

const servers: AiMcpServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });
function setup() {
  const core = { listTools: vi.fn(() => [AI_TOOL_DEFINITIONS[0]!]), invoke: vi.fn().mockResolvedValue({ value: '007' }) };
  const events = vi.fn();
  const server = new AiMcpServer({ core, token: 'test-secret', endpoint: '/unused', serverInfo: { name: 'test', version: '1' }, onConnectionChange: events });
  servers.push(server);
  server.notifyIfToolsChanged();
  const socket = new MemorySocket();
  (server as unknown as { accept(socket: MemorySocket): void }).accept(socket);
  const request = (id: number, method: string, params?: unknown) => socket.send({ jsonrpc: '2.0', id, method, params });
  const hello = () => socket.send({ hello: { protocol: 1, token: 'test-secret' } });
  const initialize = () => request(1, 'initialize', { protocolVersion: 'unknown', clientInfo: { name: 'Example', version: '2' } });
  return { server, core, socket, request, hello, initialize, events };
}

describe('MCP transport without sockets', () => {
  it('closes an unauthenticated peer without revealing a protocol reply', () => {
    const h = setup();
    h.request(1, 'tools/list');
    expect(h.socket.writable).toBe(false);
    expect(h.socket.replies).toEqual([]);
    expect(h.core.invoke).not.toHaveBeenCalled();
    expect(h.server.connectionCount()).toBe(0);
  });

  it('negotiates the protocol and refuses tools until initialized', () => {
    const h = setup(); h.hello();
    expect(h.socket.replies.pop()).toEqual({ hello: 'ok' });
    expect(h.events).toHaveBeenCalledWith({ type: 'connected', count: 1 });
    h.request(2, 'tools/list');
    expect(h.socket.replies.pop()).toMatchObject({ id: 2, error: { code: -32002 } });
    h.initialize();
    expect(h.socket.replies.pop()).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } } } });
    h.request(3, 'tools/list');
    expect(h.socket.replies.pop()).toMatchObject({ id: 3, result: { tools: [{ name: AI_TOOL_DEFINITIONS[0]!.name, annotations: { readOnlyHint: true } }] } });
    h.core.listTools.mockReturnValue([]);
    h.server.notifyIfToolsChanged();
    expect(h.socket.replies.pop()).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    h.server.notifyIfToolsChanged();
    expect(h.socket.replies).toEqual([]);
    h.socket.destroy();
    expect(h.events).toHaveBeenLastCalledWith({ type: 'disconnected', count: 0 });
  });

  it.each([
    ['{', -32700], ['[]', -32600], ['null', -32700],
    ['{"jsonrpc":"2.0","id":true,"method":"ping"}', -32600],
    ['{"jsonrpc":"2.0","id":2}', -32600]
  ])('maps invalid frames to a protocol error: %s', (line, code) => {
    const h = setup(); h.hello();
    h.socket.emit('data', Buffer.from(`${line}\n`));
    expect(h.socket.replies.at(-1)).toMatchObject({ error: { code } });
    expect(h.core.invoke).not.toHaveBeenCalled();
  });

  it.each([new Error('private implementation detail'), new AiToolError('User declined.')])('returns safe tool errors', async (error) => {
    const h = setup(); h.hello(); h.initialize();
    h.core.invoke.mockRejectedValueOnce(error);
    h.request(2, 'tools/call', { name: AI_TOOL_DEFINITIONS[0]!.name });
    await vi.waitFor(() => expect(h.socket.replies.at(-1)).toMatchObject({ id: 2, result: { isError: true,
      content: [{ type: 'text', text: error instanceof AiToolError ? 'User declined.' : 'The request failed.' }] } }));
    expect(h.core.invoke).toHaveBeenCalledWith(AI_TOOL_DEFINITIONS[0]!.name, {}, { client: 'Example 2', signal: expect.any(AbortSignal) });
  });

  it('aborts cancelled calls and suppresses their late replies', async () => {
    const h = setup(); h.hello(); h.initialize();
    let finish!: (value: unknown) => void;
    h.core.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    h.request(2, 'tools/call', { name: AI_TOOL_DEFINITIONS[0]!.name, arguments: { layout: ' Exact ' } });
    const context = h.core.invoke.mock.calls[0]![2] as { signal: AbortSignal };
    h.socket.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    expect(context.signal.aborted).toBe(true);
    finish({ ok: true });
    await Promise.resolve();
    expect(h.socket.replies.some((reply) => reply.id === 2)).toBe(false);
    h.request(3, 'ping');
    expect(h.socket.replies.at(-1)).toMatchObject({ id: 3, result: {} });
  });
});
