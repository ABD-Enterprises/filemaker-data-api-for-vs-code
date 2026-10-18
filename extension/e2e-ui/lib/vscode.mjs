// Obtaining VS Code for the tests: a per-user cache directory (mode 0700) and a download that is checked
// against the sha256 published by VS Code's update API (a different request from the file download), not
// only against the header the download server itself sends.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export function cacheDir() {
  if (process.env.E2E_VSCODE_CACHE) return process.env.E2E_VSCODE_CACHE;
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'));
  return path.join(base, 'filemaker-data-api-e2e-vscode');
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    throw new Error(`${dir} is owned by another user; refusing to use it as the VS Code cache`);
  return dir;
}

function platformId() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin';
  if (process.platform === 'linux') return `linux-${arch}`;
  return `win32-${arch}-archive`;
}

/**
 * macOS only: download the stable build named by the update API, verify its sha256 against the API's own
 * field, and unpack it where @vscode/test-electron will find it. Other platforms (or a pinned version) fall
 * back to the library's own download, which verifies only the header of the download server.
 * Returns { verified: boolean, note }.
 */
export async function prefetchVerified(cachePath, version) {
  if (process.platform !== 'darwin' || version !== 'stable')
    return {
      verified: false,
      note: 'download checked only against the download server header (independent check is implemented for stable VS Code on macOS)'
    };
  const platform = platformId();
  const api = await fetch(
    `https://update.code.visualstudio.com/api/update/${platform}/stable/latest`
  );
  if (!api.ok) throw new Error(`update API answered ${api.status}`);
  const meta = await api.json();
  const expected = String(process.env.E2E_VSCODE_SHA256 ?? meta.sha256hash ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('the update API returned no sha256');
  const dest = path.join(cachePath, `vscode-${platform}-${meta.productVersion}`);
  if (fs.existsSync(dest)) return { verified: true, note: `cached ${meta.productVersion}` };
  const res = await fetch(meta.url);
  if (!res.ok || !res.body) throw new Error(`download answered ${res.status}`);
  const tmp = path.join(cachePath, `download-${process.pid}.zip`);
  const hash = crypto.createHash('sha256');
  try {
    await pipeline(
      res.body,
      async function* (src) {
        for await (const chunk of src) {
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(tmp, { mode: 0o600 })
    );
    const actual = hash.digest('hex');
    if (actual !== expected)
      throw new Error(`sha256 mismatch: update API says ${expected}, download is ${actual}`);
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const r = spawnSync('ditto', ['-x', '-k', tmp, dest], { encoding: 'utf8' });
    if (r.status !== 0) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new Error(`could not unpack the download: ${r.stderr}`);
    }
    fs.writeFileSync(path.join(dest, 'is-complete'), ''); // the marker @vscode/test-electron looks for
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return {
    verified: true,
    note: `sha256 ${expected} matches the update API (${meta.productVersion})`
  };
}
