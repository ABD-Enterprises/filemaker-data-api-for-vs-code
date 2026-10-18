// Mock FileMaker Data API for local testing of this extension. Not shipped in the VSIX.
//
//   npm run mock:server   start it (default http://127.0.0.1:18080, override with PORT)
//   npm run mock:check    start it on a free port and run the real FMClient against it
//
// Point a connection profile at it with serverUrl http://127.0.0.1:18080, user "tester",
// password "testpass1" (test values; the server accepts nothing else). Databases:
//   Sales      baseline: Contacts (157 records) and Invoices (12)
//   Quality    ~1,400 deliberately mixed-quality records (see test/mock-server/DATASET.md)
//   Inventory  small clean database;   Locked  listed but refuses to open (error 802)
// Other accounts: admin/adminpass1 (full access like tester), viewer/viewpass1 (reads; writes refused with
// 200/205/9; field Email hidden), limited/limitpass1 (sees only layout Contacts), reader/readpass1 (read-only:
// writes and scripts get error 9), nobody/nopass1 (no layouts), retired/retired1 (inactive: error 212).
//
// Environment (all optional)
//   PORT            main port (default 18080; 0 picks a free one)
//   ADMIN_PORT      serve /__admin on a separate plain-HTTP port; the main port then refuses /__admin
//   TLS             off (default) | self-signed | ca | expired | notyet | wronghost | missing-intermediate | tls10-only
//                   (needs the openssl command; see lib/tls.mjs)
//   TTL_MS          session idle lifetime, default 900000 (15 minutes, as FileMaker)
//   MAX_SESSIONS    concurrent session cap, default 500
//   FILTER_DATABASES=1  GET /databases requires Basic auth     CLOUD=1  accept "Authorization: FMID ..."
//   SCENARIO        JSON of scenario switches (see ENDPOINTS.md), e.g. '{"delayMs":500}'
//   SEED            dataset seed (default fixed)
//
// Admin (same port, or ADMIN_PORT): GET /__admin/log | state | manifest, POST /__admin/reset | expire |
// age | config | scenario | concurrent-edit | concurrent-delete. See ENDPOINTS.md.
// Proxy mode: POST /__proxy with { action, profile, payload } and "Authorization: Bearer mock-proxy-key".
// Requests whose Host is not 127.0.0.1 or localhost are refused (403). It listens on 127.0.0.1 only.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

import { createEngine } from './lib/engine.mjs';
import { handleProxy, PROXY_PATH } from './lib/proxy.mjs';
import { makeCerts } from './lib/tls.mjs';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) { req.destroy(); throw new Error('request body too large'); }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function writeOut(res, out) {
  if (out.hang) return; // never answer (timeout tests)
  if (out.dropMid) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100000' });
    res.write(out.partial);
    setTimeout(() => res.socket?.destroy(), 50);
    return;
  }
  if (out.drop) return res.socket?.destroy();
  if (out.stream) {
    res.writeHead(out.status, out.headers);
    let left = out.stream.size;
    const chunk = Buffer.alloc(64 * 1024);
    const pump = () => {
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        left -= n;
        if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return res.once('drain', pump);
      }
      res.end();
    };
    return pump();
  }
  let body; let type = 'application/json';
  if (out.json !== undefined) body = JSON.stringify(out.json);
  else if (out.text !== undefined) { body = out.text; type = out.headers?.['Content-Type'] ?? 'text/plain'; }
  else { body = out.buffer ?? ''; type = out.headers?.['Content-Type'] ?? 'application/octet-stream'; }
  res.writeHead(out.status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...(out.headers ?? {}) });
  res.end(body);
}

/** Start the mock. Resolves { baseUrl, adminUrl, port, adminPort, caPath, engine, close }. */
export async function startMock(options = {}) {
  const env = { ...process.env, ...options.env };
  const engine = createEngine({ env });
  const tlsMode = env.TLS && env.TLS !== 'off' ? env.TLS : 'off';
  const protocol = tlsMode === 'off' ? 'http' : 'https';
  const separateAdmin = env.ADMIN_PORT !== undefined && env.ADMIN_PORT !== '';
  let certs;
  if (tlsMode !== 'off') certs = makeCerts(tlsMode);

  const adminHandler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? safeJson(await readBody(req)) : {};
    try {
      const out = engine.admin(req.method, url.pathname, url.searchParams, body);
      writeOut(res, { status: out.status ?? 200, headers: {}, json: out.json ?? {} });
    } catch (e) { writeOut(res, { status: 400, headers: {}, json: { error: e.message } }); }
  };
  const mainHandler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/__admin/')) {
        if (separateAdmin) return writeOut(res, { status: 404, headers: {}, json: {} });
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return writeOut(res, { status: 403, headers: {}, json: {} });
        return adminHandler(req, res);
      }
      const body = await readBody(req);
      const input = { method: req.method, pathname: url.pathname, query: url.searchParams, headers: req.headers, body, protocol };
      if (url.pathname === PROXY_PATH && req.method === 'POST') return writeOut(res, await handleProxy(engine, input));
      writeOut(res, await engine.dispatch(input));
    } catch (error) {
      // A malformed request must not take the mock down.
      if (!res.headersSent) writeOut(res, { status: 500, headers: {}, json: { messages: [{ code: '1', message: `Mock server error: ${error.message}` }] } });
      else res.end();
    }
  };

  const server = tlsMode === 'off' ? http.createServer(mainHandler) : https.createServer({ key: fs.readFileSync(certs.key), cert: fs.readFileSync(certs.cert), ...(certs.tlsVersions ?? {}) }, mainHandler);
  const adminServer = separateAdmin ? http.createServer(adminHandler) : undefined;
  const listen = (srv, port) => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', () => resolve(srv.address().port)); });
  const port = await listen(server, Number(env.PORT ?? 18080));
  const adminPort = adminServer ? await listen(adminServer, Number(env.ADMIN_PORT)) : port;
  const baseUrl = `${protocol}://127.0.0.1:${port}`;
  return {
    engine, port, adminPort, baseUrl, adminUrl: separateAdmin ? `http://127.0.0.1:${adminPort}` : baseUrl, caPath: certs?.caPath, intermediatePath: certs?.intermediatePath, certPath: certs?.cert, tlsMode,
    close: async () => {
      server.closeAllConnections?.(); adminServer?.closeAllConnections?.();
      await Promise.all([new Promise((r) => server.close(r)), adminServer ? new Promise((r) => adminServer.close(r)) : undefined]);
      if (certs) fs.rmSync(certs.dir, { recursive: true, force: true });
    }
  };
}
const safeJson = (buf) => { try { const v = buf.length ? JSON.parse(buf.toString('utf8')) : {}; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

/** Start the mock, print the ready lines and stop cleanly on SIGTERM/SIGINT (what `npm run mock:server` does). */
export async function main() {
  const mock = await startMock();
  console.log(`mock FileMaker Data API on ${mock.baseUrl} (user tester)`);
  console.log(`MOCK_READY ${JSON.stringify({ baseUrl: mock.baseUrl, adminUrl: mock.adminUrl, port: mock.port, adminPort: mock.adminPort, tls: mock.tlsMode, caPath: mock.caPath ?? null, intermediatePath: mock.intermediatePath ?? null, proxyUrl: `${mock.baseUrl}${PROXY_PATH}` })}`);
  const stop = async () => { await mock.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  await main();
}
