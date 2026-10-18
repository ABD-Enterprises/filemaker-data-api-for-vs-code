import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

import nock from 'nock';

export interface RunningMock {
  baseUrl: string;
  adminUrl: string;
  caPath: string | null;
  proxyUrl: string;
  stop: () => Promise<void>;
}

/** Starts test/mock-server/server.mjs on a free port with the given env and resolves when it is ready. */
export async function startMockProcess(env: Record<string, string> = {}): Promise<RunningMock> {
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  const child: ChildProcess = spawn(
    process.execPath,
    [path.resolve(__dirname, '../../mock-server/server.mjs')],
    {
      env: { ...process.env, PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'inherit']
    }
  );
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('mock did not start')), 20000);
    child.once('exit', (code) => reject(new Error(`mock exited early (${code})`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.split('\n').find((l) => l.startsWith('MOCK_READY '));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice('MOCK_READY '.length)) as Record<string, unknown>);
      }
    });
  });
  return {
    baseUrl: ready.baseUrl as string,
    adminUrl: ready.adminUrl as string,
    caPath: (ready.caPath as string | null) ?? null,
    proxyUrl: ready.proxyUrl as string,
    stop: () =>
      new Promise<void>((resolve) => {
        child.removeAllListeners('exit');
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      })
  };
}

export const basicAuth = (user = 'tester', pass = 'testpass1') =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

export interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
}

export function api(baseUrl: string, version = 'vLatest') {
  const root = `${baseUrl}/fmi/data/${version}`;
  const call = async (
    method: string,
    route: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}
  ): Promise<Reply> => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] ??= 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await fetch(root + route, {
      method,
      headers,
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, headers: res.headers };
  };
  const login = async (db = 'Quality', user = 'tester', pass = 'testpass1') => {
    const r = await call('POST', `/databases/${encodeURIComponent(db)}/sessions`, {
      body: {},
      headers: { Authorization: basicAuth(user, pass) }
    });
    return { ...r, token: r.body?.response?.token as string };
  };
  return { call, login, root };
}

/** The TLS modes generate their certificates with the openssl command; without it those tests are skipped. */
export const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
if (!hasOpenssl)
  console.warn(
    'mock TLS tests are skipped: the openssl command is not on PATH (apt/brew install openssl)'
  );
