import net from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Duplex, PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HELLO_ACK, helloLine } from '../../../../src/ai/mcp/auth';
import type { DiscoveryScan } from '../../../../src/ai/mcp/discovery';
import { runShim, type ShimDependencies } from '../../../../src/ai/mcp/runShim';

class Socket extends Duplex {
  public readonly writes: Buffer[] = [];
  public constructor() { super({ allowHalfOpen: false }); }
  public _read(): void {}
  public _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.writes.push(Buffer.from(chunk));
    callback();
  }
  public receive(data: Buffer | string): void { this.emit('data', data); }
  public text(): string { return Buffer.concat(this.writes).toString(); }
}

function fixture(overrides: Partial<ShimDependencies> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Buffer[] = [];
  let errors = '';
  stdout.on('data', (chunk) => { output.push(Buffer.from(chunk)); });
  stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const socket = new Socket();
  const scan: DiscoveryScan = {
    live: [{ file: '/discovery/window.json', record: {
      version: 1, socketPath: '/private/socket', pid: 42, startTime: 'start',
      token: 'a'.repeat(64), workspaceFolders: ['/alpha'], label: 'alpha', created: 'now'
    } }], unsafe: [], stale: [], unverified: []
  };
  let connected: () => void = () => undefined;
  const connection = new Promise<void>((resolve) => { connected = resolve; });
  const connect = vi.fn(() => { connected(); return socket as unknown as net.Socket; });
  const scanDiscovery = vi.fn(async () => scan);
  const assertOwnerOnly = vi.fn(async () => undefined);
  const lstat = vi.fn(async () => ({ isSocket: () => true, uid: 501 })) as unknown as NonNullable<ShimDependencies['lstat']>;
  const dependencies: ShimDependencies = {
    stdin, stdout, stderr, argv: ['node', 'shim', '--dir', '/discovery'], env: {},
    platform: 'darwin', getuid: () => 501, connect, scanDiscovery, assertOwnerOnly, lstat, ...overrides
  };
  const result = runShim(dependencies);
  async function ready() {
    await connection;
    socket.emit('connect');
  }
  return { stdin, socket, result, ready, scan, connect, scanDiscovery, assertOwnerOnly, lstat, output: () => Buffer.concat(output).toString(), errors: () => errors };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runShim', () => {
  it('sends only the token hello before acknowledgement and preserves JSON-RPC bytes and line framing both ways', async () => {
    const f = fixture();
    const requests = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\r\n';
    f.stdin.write(requests.slice(0, 10));
    await f.ready();
    expect(f.socket.text()).toBe(helloLine('a'.repeat(64)));
    f.socket.receive('{"hello":');
    expect(f.output()).toBe('');
    expect(f.socket.text()).toBe(helloLine('a'.repeat(64)));
    const replies = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"顧客"}\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
    f.socket.receive(Buffer.concat([Buffer.from('"ok"}\r\n'), replies.subarray(0, 39)]));
    f.socket.receive(replies.subarray(39));
    f.stdin.write(requests.slice(10));
    await vi.waitFor(() => expect(f.socket.text()).toBe(helloLine('a'.repeat(64)) + requests));
    expect(f.output()).toBe(replies.toString());
    expect(f.errors()).toBe('');
    f.socket.emit('close');
    expect(await f.result).toBe(0);
  });

  it('passes oversized and garbled protocol lines through unchanged after authentication', async () => {
    const f = fixture();
    await f.ready();
    f.socket.receive(`${HELLO_ACK}\n`);
    const payload = `{garbled\n${'x'.repeat(20_000)}\nunterminated`;
    f.stdin.write(payload);
    f.socket.receive(payload);
    await vi.waitFor(() => expect(f.socket.text()).toBe(helloLine('a'.repeat(64)) + payload));
    expect(f.output()).toBe(payload);
    f.socket.emit('close');
    expect(await f.result).toBe(0);
  });

  it.each(['garbled\n', '{"hello":"no"}\n'])('refuses a bad acknowledgement %j without forwarding input', async (reply) => {
    const f = fixture();
    await f.ready();
    f.stdin.write('private request\n');
    f.socket.receive(reply);
    expect(await f.result).toBe(1);
    expect(f.errors()).toBe('filemaker-ai: the AI server refused the connection.\n');
    expect(f.output()).toBe('');
    expect(f.socket.text()).toBe(helloLine('a'.repeat(64)));
  });

  it('allows 1024 pending hello bytes but rejects the next byte without a newline', async () => {
    const f = fixture();
    await f.ready();
    f.socket.receive('x'.repeat(1024));
    expect(f.errors()).toBe('');
    f.socket.receive('x');
    expect(await f.result).toBe(1);
    expect(f.errors()).toBe('filemaker-ai: unexpected reply from the AI server.\n');
    expect(f.output()).toBe('');
  });

  it.each([false, true])('ends the socket on stdin EOF (authenticated: %s)', async (authenticated) => {
    const f = fixture();
    await f.ready();
    if (authenticated) f.socket.receive(`${HELLO_ACK}\n`);
    f.stdin.end();
    // Before auth stdin is deliberately not flowing, as in the shipped bridge.
    if (!authenticated) f.stdin.resume();
    await vi.waitFor(() => expect(f.socket.writableEnded).toBe(true));
    f.socket.emit('close');
    expect(await f.result).toBe(authenticated ? 0 : 1);
    expect(f.output()).toBe('');
    expect(f.errors()).toBe(authenticated ? '' : 'filemaker-ai: the AI server refused the connection (wrong token, too many connections, or it is shutting down).\n');
  });

  it.each([false, true])('returns the same exit status on server EOF (authenticated: %s)', async (authenticated) => {
    const f = fixture();
    await f.ready();
    if (authenticated) f.socket.receive(`${HELLO_ACK}\n`);
    f.socket.push(null);
    expect(await f.result).toBe(authenticated ? 0 : 1);
    expect(f.output()).toBe('');
    expect(f.errors()).toBe(authenticated ? '' : 'filemaker-ai: the AI server refused the connection (wrong token, too many connections, or it is shutting down).\n');
  });

  it('clears the hello deadline after acknowledgement, including whitespace before the newline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.ready();
    f.socket.receive(` ${HELLO_ACK}${' '.repeat(1100)}\r\n`);
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.errors()).toBe('');
    expect(f.socket.destroyed).toBe(false);
    f.socket.emit('close');
    expect(await f.result).toBe(0);
  });

  it('waits for pending stdout to flush when the server closes', async () => {
    let flushed: (() => void) | undefined;
    const stdout = { write: vi.fn((_data: unknown, callback?: () => void) => { flushed = callback; return true; }) };
    const f = fixture({ stdout: stdout as unknown as NodeJS.WritableStream });
    await f.ready();
    f.socket.receive(`${HELLO_ACK}\nlast reply\n`);
    let finished = false;
    void f.result.then(() => { finished = true; });
    f.socket.emit('close');
    expect(stdout.write).toHaveBeenCalledWith(Buffer.from('last reply\n'));
    await Promise.resolve();
    expect(finished).toBe(false);
    flushed?.();
    expect(await f.result).toBe(0);
  });

  it('reports connection errors and times out a server that never acknowledges', async () => {
    const failed = fixture();
    await failed.ready();
    failed.socket.emit('error', new Error('gone'));
    expect(await failed.result).toBe(1);
    expect(failed.errors()).toBe('filemaker-ai: cannot connect to the AI server: gone\n');
    vi.useFakeTimers();
    const stalled = fixture();
    await stalled.ready();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stalled.result).toBe(1);
    expect(stalled.socket.destroyed).toBe(true);
    expect(stalled.errors()).toBe('filemaker-ai: timed out connecting to the AI server.\n');
  });

  it('uses env fallbacks, with command-line arguments taking precedence', async () => {
    for (const argv of [[], ['--dir', '--workspace'], ['--dir', '/chosen', '--workspace', 'alpha']]) {
      const f = fixture({ argv, env: { FM_AI_DIR: '/fallback', FM_AI_WORKSPACE: 'alpha' }, platform: 'win32' });
      await f.ready();
      expect(f.scanDiscovery).toHaveBeenCalledWith(argv.includes('/chosen') ? '/chosen' : '/fallback');
      expect(f.assertOwnerOnly).not.toHaveBeenCalled();
      expect(f.lstat).not.toHaveBeenCalled();
      f.socket.receive(`${HELLO_ACK}\n`);
      f.socket.emit('close');
      expect(await f.result).toBe(0);
    }
  });

  it('uses the real discovery reader for an empty discovery folder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shim-unit-'));
    try {
      const f = fixture({ argv: ['--dir', directory], scanDiscovery: undefined });
      expect(await f.result).toBe(1);
      expect(f.errors()).toContain('No VS Code window is running');
      expect(f.connect).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the default connector with the discovered path', async () => {
    const connect = vi.spyOn(net, 'connect');
    const f = fixture({ connect: undefined, platform: 'win32' });
    connect.mockReturnValue(f.socket as unknown as net.Socket);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith('/private/socket'));
    f.socket.emit('connect');
    expect(f.socket.text()).toBe(helloLine('a'.repeat(64)));
    f.socket.receive(`${HELLO_ACK}\n`);
    f.socket.emit('close');
    expect(await f.result).toBe(0);
  });

  it('reports a missing discovery argument, missing folder, or missing discovery file without connecting', async () => {
    const missing = fixture({ argv: [] });
    expect(await missing.result).toBe(1);
    expect(missing.errors()).toBe('filemaker-ai: missing --dir (the discovery folder; use the config from "FileMaker: Copy MCP Config for Claude Code / Cursor").\n');
    expect(missing.scanDiscovery).not.toHaveBeenCalled();
    const folder = fixture({ scanDiscovery: async () => { throw new Error('ENOENT\nfolder'); } });
    expect(await folder.result).toBe(1);
    expect(folder.errors()).toBe('filemaker-ai: cannot use the discovery folder: ENOENT?folder\n');
    const empty = fixture({ scanDiscovery: async () => ({ live: [], unsafe: [], stale: [], unverified: [] }) });
    expect(await empty.result).toBe(1);
    expect(empty.errors()).toContain('No VS Code window is running');
    for (const f of [missing, folder, empty]) {
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.output()).toBe('');
    }
  });

  it('prints safe warnings and refuses an unmatched workspace', async () => {
    const f = fixture({ argv: ['--dir', '/discovery', '--workspace', 'other'] });
    f.scan.unsafe.push({ file: 'bad\nfile', reason: 'bad\u001bmode' });
    expect(await f.result).toBe(1);
    expect(f.errors()).toContain('filemaker-ai: ignoring bad?file: bad?mode\n');
    expect(f.errors()).toContain('No live window matches "other"');
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each(['folder', 'file', 'owner', 'not socket', 'no getuid'] as const)('checks the socket before sending its token: %s', async (kind) => {
    const f = fixture({
      getuid: kind === 'no getuid' ? undefined : () => 501,
      assertOwnerOnly: async () => { if (kind === 'folder') throw new Error('unsafe\nfolder'); },
      lstat: vi.fn(async () => {
        if (kind === 'file') throw new Error('missing\nsocket');
        return { isSocket: () => kind !== 'not socket', uid: kind === 'owner' ? 502 : 501 };
      }) as unknown as NonNullable<ShimDependencies['lstat']>
    });
    if (kind === 'no getuid') {
      await f.ready();
      f.socket.receive(`${HELLO_ACK}\n`);
      f.socket.emit('close');
      expect(await f.result).toBe(0);
    } else {
      expect(await f.result).toBe(1);
      expect(f.errors()).toBe(`filemaker-ai: will not connect: ${kind === 'folder' ? 'unsafe?folder' : kind === 'file' ? 'missing?socket' : 'it is not a socket owned by the current user.'}\n`);
      expect(f.connect).not.toHaveBeenCalled();
    }
  });
});
