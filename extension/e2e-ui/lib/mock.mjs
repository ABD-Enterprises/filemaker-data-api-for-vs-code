// Starts the mock Data API (extension/test/mock-server/server.mjs) as a child process.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const mockEntry = path.resolve(here, 'fm-fixture.mjs');

export async function startMock(env = {}) {
  const child = spawn(process.execPath, [mockEntry], {
    env: { ...process.env, PORT: '0', ADMIN_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  child.on('exit', (code, signal) => {
    if (!child.__stopping)
      console.error(`[mock] exited unexpectedly: code ${code}, signal ${signal}`);
  });
  const ready = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('mock did not start')), 30000);
    child.once('exit', (c) => reject(new Error(`mock exited early (${c})`)));
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.startsWith('MOCK_READY '));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice(11)));
      }
    });
  });
  const admin = async (route, body) =>
    (
      await fetch(ready.adminUrl + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    ).json();
  const origin = ready.baseUrl;
  // Direct access to the mock's Data API for assertions (its own session, never the extension's).
  const data = (db = 'Quality', user = 'tester', pass = 'testpass1') => {
    let token;
    const call = async (method, route, body) => {
      if (!token) {
        const r = await fetch(`${origin}/fmi/data/vLatest/databases/${db}/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
          },
          body: '{}'
        });
        token = (await r.json()).response.token;
      }
      const r = await fetch(`${origin}/fmi/data/vLatest/databases/${db}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: r.status, body: await r.json() };
    };
    const L = (n) => `/layouts/${encodeURIComponent(n)}`;
    return {
      call,
      record: async (layout, id) =>
        (await call('GET', `${L(layout)}/records/${id}`)).body.response?.data?.[0],
      find: async (layout, query, extra = {}) =>
        (await call('POST', `${L(layout)}/_find`, { query, ...extra })).body,
      count: async (layout) =>
        (await call('GET', `${L(layout)}/records?_limit=1`)).body.response?.dataInfo
          ?.totalRecordCount
    };
  };
  const manifest = async () => (await fetch(`${ready.adminUrl}/__admin/manifest`)).json();
  return {
    ...ready,
    data,
    manifest,
    admin,
    log: async () => (await admin('/__admin/log')).log,
    stop: () =>
      new Promise((resolve) => {
        child.__stopping = true;
        child.removeAllListeners('exit');
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      })
  };
}
