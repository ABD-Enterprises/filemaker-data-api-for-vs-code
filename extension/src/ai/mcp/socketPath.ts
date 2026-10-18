import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { ensureOwnerOnlyDirectory } from './discovery';

/** macOS limits a Unix socket path to 104 bytes including the terminator; stay well under. */
export const MAX_SOCKET_PATH_BYTES = 100;

export interface Endpoint {
  /** Unix socket path or Windows pipe name. */
  path: string;
  /** Folder to remove on stop (Unix), if this call created the socket in it. */
  isPipe: boolean;
}

/**
 * Where to listen. Windows: an unguessable named pipe (Node cannot promise a user-only ACL
 * on it, so the token in the hello message is the control). Unix: a socket in a folder that
 * is created 0700 and checked (owner, mode, not a link), with a short path.
 *
 * `baseDirectory` is for tests; by default `$XDG_RUNTIME_DIR` (already 0700 on Linux) or
 * the temp folder.
 */
export async function createEndpoint(options: { platform?: NodeJS.Platform; baseDirectory?: string } = {}): Promise<Endpoint> {
  const platform = options.platform ?? process.platform;
  const id = randomBytes(16).toString('hex');
  if (platform === 'win32') {
    return { path: `\\\\.\\pipe\\fm-ai-${id}`, isPipe: true };
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const base = options.baseDirectory ?? process.env.XDG_RUNTIME_DIR ?? tmpdir();
  const directory = join(base, `fmai-${uid}`);
  await ensureOwnerOnlyDirectory(directory);
  const path = join(directory, `${id.slice(0, 12)}.sock`);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`The socket path would be ${Buffer.byteLength(path)} bytes, over the ${MAX_SOCKET_PATH_BYTES} byte limit. Set TMPDIR to a shorter folder.`);
  }
  return { path, isPipe: false };
}
