import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RawClient } from './mcpClientHelper';

async function client() {
  const socket = new net.Socket();
  vi.spyOn(net, 'connect').mockReturnValue(socket);
  const connecting = RawClient.connect('/unused');
  socket.emit('connect');
  return { socket, raw: await connecting };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('RawClient event waits', () => {
  it('wakes on complete lines, preserves partial frames, and removes deadline timers', async () => {
    vi.useFakeTimers();
    const { socket, raw } = await client();
    const next = raw.next();
    socket.emit('data', Buffer.from('{"id":'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    socket.emit('data', Buffer.from('1}\nsecond\n'));
    expect(await next).toBe('{"id":1}');
    expect(await raw.next()).toBe('second');
    expect(vi.getTimerCount()).toBe(0);
    raw.close();
  });

  it('wakes both a line waiter and a close waiter on close without polling', async () => {
    vi.useFakeTimers();
    const { socket, raw } = await client();
    const next = raw.next();
    const closed = raw.waitClosed();
    expect(vi.getTimerCount()).toBe(2);
    socket.emit('close');
    expect(await next).toBe('<closed>');
    expect(await closed).toBe(true);
    expect(await raw.next()).toBe('<closed>');
    expect(await raw.waitClosed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    raw.close();
  });

  it('uses a single deadline and removes expired waiters before another read', async () => {
    vi.useFakeTimers();
    const { socket, raw } = await client();
    const timeout = raw.next(100);
    const closed = raw.waitClosed(100);
    // An incomplete line wakes readers but must not extend the original deadline.
    await vi.advanceTimersByTimeAsync(75);
    socket.emit('data', Buffer.from('partial'));
    await vi.advanceTimersByTimeAsync(25);
    expect(await timeout).toBe('<timeout>');
    expect(await closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const next = raw.next(100);
    socket.emit('data', Buffer.from('\n'));
    expect(await next).toBe('partial');
    expect(vi.getTimerCount()).toBe(0);
    raw.close();
  });
});
