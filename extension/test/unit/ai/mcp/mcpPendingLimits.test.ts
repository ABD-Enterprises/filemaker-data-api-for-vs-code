import { EventEmitter } from 'events';
import net from 'net';
import { afterEach, expect, it, vi } from 'vitest';
import { AiMcpServer } from '../../../../src/ai/mcp/aiMcpServer';
import { helloLine } from '../../../../src/ai/mcp/auth';

class Socket extends EventEmitter {
  public writable = true;
  public writableLength = 0;
  public write = vi.fn();
  public setNoDelay() {}
  public setTimeout() {}
  public destroy() { this.writable = false; this.emit('close'); }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('bounds a flood of pending handshakes, preserves authenticated clients, and expires partial hellos', async () => {
  vi.useFakeTimers();
  let accept: (socket: Socket) => void = () => { throw new Error('server not started'); };
  const transport = new EventEmitter() as EventEmitter & { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; maxConnections: number };
  transport.listen = vi.fn((_endpoint, ready) => ready());
  transport.close = vi.fn((done) => done());
  vi.spyOn(net, 'createServer').mockImplementation(((cb: (socket: Socket) => void) => { accept = cb; return transport; }) as never);
  const core = { listTools: () => [], invoke: vi.fn() };
  const server = new AiMcpServer({ core, token: 'token', endpoint: '/unused', serverInfo: { name: 'test', version: '1' },
    chmodSocket: async () => {}, limits: { maxConnections: 2, maxUnauthenticated: 3, helloTimeoutMs: 1000 } });
  await server.start();
  try {
    expect(transport.maxConnections).toBe(5);
    const authed = new Socket();
    accept(authed);
    authed.emit('data', Buffer.from(helloLine('token')));
    expect(server.connectionCount()).toBe(1);
    const pending: Socket[] = [];
    for (let i = 0; i < 30; i += 1) {
      const socket = new Socket();
      accept(socket);
      socket.emit('data', Buffer.from('{"hello":'));
      pending.push(socket);
      expect(pending.filter((s) => s.writable).length).toBeLessThanOrEqual(3);
    }
    expect(pending.slice(-3).every((s) => s.writable)).toBe(true);
    await vi.advanceTimersByTimeAsync(1001);
    expect(pending.every((s) => !s.writable)).toBe(true);
    expect(authed.writable).toBe(true);
    expect(server.connectionCount()).toBe(1);
    expect(core.invoke).not.toHaveBeenCalled();
  } finally {
    await server.stop();
  }
});
