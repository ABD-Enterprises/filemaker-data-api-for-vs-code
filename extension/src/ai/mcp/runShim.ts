import net from 'net';
import { lstat as defaultLstat } from 'fs/promises';
import { dirname } from 'path';

import { HELLO_ACK, helloLine } from './auth';
import { assertOwnerOnly as defaultAssertOwnerOnly, safeText, scanDiscovery as defaultScanDiscovery, selectWindow } from './discovery';

const CONNECT_TIMEOUT_MS = 5000;

export interface ShimDependencies {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  getuid?: () => number;
  connect?: (path: string) => net.Socket;
  scanDiscovery?: typeof defaultScanDiscovery;
  assertOwnerOnly?: typeof defaultAssertOwnerOnly;
  lstat?: typeof defaultLstat;
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

/** Run the stdio bridge without owning the caller's process. */
export async function runShim({
  stdin, stdout, stderr, argv, env, platform, getuid,
  connect = (path) => net.connect(path),
  scanDiscovery = defaultScanDiscovery,
  assertOwnerOnly = defaultAssertOwnerOnly,
  lstat = defaultLstat
}: ShimDependencies): Promise<number> {
  let complete: ((code: number) => void) | undefined;
  function fail(message: string): number {
    stderr.write(`filemaker-ai: ${message}\n`);
    complete?.(1);
    return 1;
  }
  const directory = argument(argv, 'dir') ?? env.FM_AI_DIR;
  if (!directory) {
    return fail('missing --dir (the discovery folder; use the config from "FileMaker: Copy MCP Config for Claude Code / Cursor").');
  }
  const workspace = argument(argv, 'workspace') ?? env.FM_AI_WORKSPACE;

  let scan;
  try {
    scan = await scanDiscovery(directory);
  } catch (error) {
    return fail(`cannot use the discovery folder: ${safeText((error as Error).message)}`);
  }
  for (const entry of scan.unsafe) {
    stderr.write(`filemaker-ai: ignoring ${safeText(entry.file)}: ${safeText(entry.reason)}\n`);
  }

  const selection = selectWindow(scan.live, workspace, scan.unverified);
  if (!selection.ok) {
    return fail(selection.message);
  }
  const { record } = selection.window;
  if (platform !== 'win32') {
    try {
      // The socket must be one this extension made, in a folder only this user can use.
      await assertOwnerOnly(dirname(record.socketPath), 'directory');
      const stats = await lstat(record.socketPath);
      if (!stats.isSocket() || (typeof getuid === 'function' && stats.uid !== getuid())) {
        throw new Error('it is not a socket owned by the current user.');
      }
    } catch (error) {
      return fail(`will not connect: ${safeText((error as Error).message)}`);
    }
  }

  const socket = connect(record.socketPath);
  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(code);
    };
    complete = finish;
    const timer = setTimeout(() => {
      socket.destroy();
      fail('timed out connecting to the AI server.');
    }, CONNECT_TIMEOUT_MS);

    let acknowledged = false;
    let buffered = Buffer.alloc(0);
    socket.once('connect', () => socket.write(helloLine(record.token)));
    socket.on('error', (error) => fail(`cannot connect to the AI server: ${error.message}`));
    socket.on('close', () => {
      if (finished) return;
      // Let pending output reach the client before the process ends.
      if (!acknowledged) {
        stderr.write('filemaker-ai: the AI server refused the connection (wrong token, too many connections, or it is shutting down).\n');
      }
      stdout.write('', () => finish(acknowledged ? 0 : 1));
    });
    socket.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (acknowledged) {
        stdout.write(data);
        return;
      }
      buffered = Buffer.concat([buffered, data]);
      const end = buffered.indexOf(0x0a);
      if (end === -1) {
        if (buffered.length > 1024) {
          fail('unexpected reply from the AI server.');
        }
        return;
      }
      if (buffered.toString('utf8', 0, end).trim() !== HELLO_ACK) {
        fail('the AI server refused the connection.');
        return;
      }
      acknowledged = true;
      clearTimeout(timer);
      const rest = buffered.subarray(end + 1);
      if (rest.length > 0) {
        stdout.write(rest);
      }
      stdin.pipe(socket);
    });
    stdin.on('end', () => socket.end());
  });
}
