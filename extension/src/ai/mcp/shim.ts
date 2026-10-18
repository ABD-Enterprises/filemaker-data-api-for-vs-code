/**
 * The stdio shim that MCP clients (Claude Code, Cursor and others) launch:
 *
 *   node aiMcpShim.js --dir <discovery folder> [--workspace <folder or name>]
 *
 * It finds the VS Code window that runs the FileMaker AI server, checks that the process in
 * the discovery file is alive and is the same run (pid and start time) before it sends the
 * token, connects to the local socket, authenticates, and then only copies bytes between
 * stdin/stdout and the socket. It holds no credentials for FileMaker and applies no policy.
 * stdout carries nothing but protocol messages; every diagnostic goes to stderr.
 */
import net from 'net';

import { HELLO_ACK, helloLine } from './auth';
import { scanDiscovery, selectWindow } from './discovery';

const CONNECT_TIMEOUT_MS = 5000;

function fail(message: string): never {
  process.stderr.write(`filemaker-ai: ${message}\n`);
  process.exit(1);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const directory = argument('dir') ?? process.env.FM_AI_DIR;
  if (!directory) {
    fail('missing --dir (the discovery folder; use the config from "FileMaker: Copy MCP Config for Claude Code / Cursor").');
  }
  const workspace = argument('workspace') ?? process.env.FM_AI_WORKSPACE;

  let scan;
  try {
    scan = await scanDiscovery(directory);
  } catch (error) {
    fail(`cannot use the discovery folder: ${(error as Error).message}`);
  }
  for (const entry of scan.unsafe) {
    process.stderr.write(`filemaker-ai: ignoring ${entry.file}: ${entry.reason}\n`);
  }

  const selection = selectWindow(scan.live, workspace);
  if (!selection.ok) {
    fail(selection.message);
  }
  const { record } = selection.window;

  const socket = net.connect(record.socketPath);
  const timer = setTimeout(() => {
    socket.destroy();
    fail('timed out connecting to the AI server.');
  }, CONNECT_TIMEOUT_MS);

  let acknowledged = false;
  let buffered = Buffer.alloc(0);
  socket.once('connect', () => socket.write(helloLine(record.token)));
  socket.on('error', (error) => fail(`cannot connect to the AI server: ${error.message}`));
  socket.on('close', () => {
    // Let pending output reach the client before the process ends.
    if (!acknowledged) {
      process.stderr.write('filemaker-ai: the AI server refused the connection (wrong token, too many connections, or it is shutting down).\n');
    }
    process.stdout.write('', () => process.exit(acknowledged ? 0 : 1));
  });
  socket.on('data', (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (acknowledged) {
      process.stdout.write(data);
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
    }
    acknowledged = true;
    clearTimeout(timer);
    const rest = buffered.subarray(end + 1);
    if (rest.length > 0) {
      process.stdout.write(rest);
    }
    process.stdin.pipe(socket);
  });
  process.stdin.on('end', () => socket.end());
}

void main();
