// Mock FileMaker Data API for local testing of this extension. Not shipped in the VSIX.
//
//   npm run mock:server   start it (default http://127.0.0.1:18080, override with PORT)
//   npm run mock:check    start it on a free port and run the real FMClient against it
//
// Point a connection profile at it with serverUrl http://127.0.0.1:18080, database "Sales",
// username "tester", password "testpass1" (test values; the server accepts nothing else).
// Layouts: Contacts (157 records) and Invoices (12). Fault injection and inspection:
//   GET /__admin/expire   forget every session token (next request gets HTTP 401 / code 952)
//   GET /__admin/reset    clear the request log and restore the fixture data
//   GET /__admin/log      requests seen so far and the number of POST /sessions
//
// It mirrors the Claris Data API response shapes and error codes the extension relies on:
// a find with no matches (or an offset past the last match) is HTTP 404 + code 401, a bad
// token is HTTP 401 + code 952, a stale modId on an edit is HTTP 500 + code 306, offsets are
// 1-based. Find semantics are simplified (== exact or prefix with a trailing *, *"phrase",
// < > <= >=, a...b, = empty, * not empty, plain value matches a word prefix, backslash escapes)
// and are an approximation of FileMaker, not a specification. It listens on 127.0.0.1 only.
import http from 'node:http';
import crypto from 'node:crypto';

const USER = 'tester';
const PASS = 'testpass1';
const DB = 'Sales';
const base = `/fmi/data/vLatest/databases/${DB}`;

const FIRST = ['Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Linus', 'Margaret', 'Dennis'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Dijkstra', 'Liskov', 'Torvalds', 'Hamilton', 'Ritchie'];
const state = { tokens: new Set(), log: [], nextId: 1, tables: {}, sessionPosts: 0 };

function seed() {
  state.tables.Contacts = [];
  for (let i = 1; i <= 157; i += 1) {
    state.tables.Contacts.push({
      recordId: String(1000 + i),
      modId: '0',
      fieldData: {
        FirstName: FIRST[i % 8],
        LastName: LAST[(i * 3) % 8],
        Email: `user${i}@example.com`,
        Status: i % 3 ? 'Open' : 'Closed',
        Amount: (i * 37) % 500,
        Region: ['West', 'East', 'North'][i % 3],
        Notes: i % 10 === 0 ? '' : `Customer note ${i}: John Smith visited on site`,
        Created: `10/${1 + (i % 28)}/2026`
      }
    });
  }
  state.tables.Invoices = [];
  for (let i = 1; i <= 12; i += 1) {
    state.tables.Invoices.push({
      recordId: String(2000 + i),
      modId: '0',
      fieldData: { Invoice: `INV-${1040 + i}`, Customer: `Customer ${i}`, Balance: i * 125.5, Status: i % 2 ? 'Open' : 'Paid' }
    });
  }
  state.nextId = 5000;
}
seed();

const FIELD_TYPES = { Amount: 'number', Balance: 'number', Created: 'date' };
const meta = (layout) =>
  Object.keys(state.tables[layout][0].fieldData).map((name) => ({
    name,
    type: 'normal',
    displayType: 'editText',
    result: FIELD_TYPES[name] ?? 'text',
    global: false,
    autoEnter: false,
    four2DigitYear: false,
    maxRepeat: 1,
    maxCharacters: 0,
    notEmpty: false,
    numeric: FIELD_TYPES[name] === 'number',
    repetitions: 1,
    timeOfDay: false
  }));

const msg = (code, message) => ({ messages: [{ code: String(code), message }] });
const ok = (response) => ({ response, messages: [{ code: '0', message: 'OK' }] });

function unescapeFind(v) { return String(v).replace(/\\(.)/g, '$1'); }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function toDate(v) { const t = Date.parse(String(v)); return Number.isFinite(t) ? t : undefined; }
function cmpVal(field, raw) {
  const s = String(field ?? '');
  const n = toNum(s); if (n !== undefined && s.trim() !== '') return n;
  const d = toDate(s); if (d !== undefined && /\//.test(s)) return d;
  return s.toLowerCase();
}

function fieldMatches(value, criterion) {
  const c = String(criterion);
  const text = String(value ?? '');
  const lower = text.toLowerCase();
  if (c === '=') return text === '';
  if (c === '*') return text !== '';
  const phrase = c.match(/^\*"((?:[^"\\]|\\.)*)"$/);
  if (phrase) return lower.includes(unescapeFind(phrase[1]).toLowerCase());
  if (c.startsWith('==')) {
    const rest = c.slice(2);
    if (rest.endsWith('*') && !rest.endsWith('\\*')) return lower.startsWith(unescapeFind(rest.slice(0, -1)).toLowerCase());
    return lower === unescapeFind(rest).toLowerCase();
  }
  for (const [op, fn] of [['>=', (a, b) => a >= b], ['<=', (a, b) => a <= b], ['>', (a, b) => a > b], ['<', (a, b) => a < b]]) {
    if (c.startsWith(op)) return text !== '' && fn(cmpVal(text), cmpVal(unescapeFind(c.slice(op.length))));
  }
  const range = c.match(/^((?:[^.\\]|\\.)+)\.\.\.((?:[^.\\]|\\.)+)$/);
  if (range) { const v = cmpVal(text); return text !== '' && v >= cmpVal(unescapeFind(range[1])) && v <= cmpVal(unescapeFind(range[2])); }
  // plain value: any word in the field begins with it (FileMaker's default find)
  const needle = unescapeFind(c).toLowerCase();
  return lower.split(/[\s,]+/).some((w) => w.startsWith(needle));
}

function runFind(rows, query) {
  const matched = new Set();
  const omitted = new Set();
  for (const request of query) {
    const { omit, ...criteria } = request;
    const hits = rows.filter((r) => Object.entries(criteria).every(([f, c]) => fieldMatches(r.fieldData[f], c)));
    for (const r of hits) (String(omit).toLowerCase() === 'true' ? omitted : matched).add(r);
  }
  return rows.filter((r) => matched.has(r) && !omitted.has(r));
}

function page(rows, offset, limit, layout, total) {
  const start = Math.max(1, offset || 1);
  const size = limit || 100;
  const slice = rows.slice(start - 1, start - 1 + size);
  return {
    data: slice,
    dataInfo: { database: DB, layout, table: layout, totalRecordCount: total, foundCount: rows.length, returnedCount: slice.length }
  };
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  try { return t ? JSON.parse(t) : {}; } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
  state.log.push({ method: req.method, path: path.replace(base, ''), query: url.search, body: Object.keys(body).length ? body : undefined });

  if (path.startsWith('/__admin/')) {
    if (path === '/__admin/log') return send(res, 200, { log: state.log, sessionPosts: state.sessionPosts });
    if (path === '/__admin/reset') { state.log.length = 0; state.sessionPosts = 0; seed(); return send(res, 200, {}); }
    if (path === '/__admin/expire') { state.tokens.clear(); return send(res, 200, {}); }
    return send(res, 404, {});
  }
  if (!path.startsWith(base)) return send(res, 404, msg(105, 'Database is missing'));
  const rest = path.slice(base.length);

  if (rest === '/sessions' && req.method === 'POST') {
    state.sessionPosts += 1;
    const [u, p] = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':');
    if (u !== USER || p !== PASS) return send(res, 401, msg(212, 'Invalid user account and/or password; please try again'));
    const token = crypto.randomBytes(32).toString('hex');
    state.tokens.add(token);
    return send(res, 200, ok({ token }));
  }
  const del = rest.match(/^\/sessions\/(.+)$/);
  if (del && req.method === 'DELETE') { state.tokens.delete(del[1]); return send(res, 200, ok({})); }

  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!state.tokens.has(bearer)) return send(res, 401, msg(952, 'Invalid FileMaker Data API token (*)'));

  if (rest === '/layouts' && req.method === 'GET') return send(res, 200, ok({ layouts: Object.keys(state.tables).map((name) => ({ name })) }));
  if (rest === '/scripts' && req.method === 'GET') return send(res, 200, ok({ scripts: [{ name: 'Rebuild Index', isFolder: false }, { name: 'Echo', isFolder: false }] }));

  const m = rest.match(/^\/layouts\/([^/]+)(\/.*)?$/);
  if (!m) return send(res, 404, msg(102, 'Field is missing'));
  const layout = decodeURIComponent(m[1]);
  const tail = m[2] ?? '';
  const rows = state.tables[layout];
  if (!rows) return send(res, 500, msg(105, 'Layout is missing'));

  if (tail === '' && req.method === 'GET') return send(res, 200, ok({ fieldMetaData: meta(layout), portalMetaData: {}, valueLists: [] }));

  if (tail === '/_find' && req.method === 'POST') {
    if (!Array.isArray(body.query)) return send(res, 500, msg(960, 'Find query is invalid'));
    let found = runFind(rows, body.query);
    for (const s of [...(body.sort ?? [])].reverse()) {
      const dir = s.sortOrder === 'descend' ? -1 : 1;
      found = [...found].sort((a, b) => {
        const x = cmpVal(a.fieldData[s.fieldName]); const y = cmpVal(b.fieldData[s.fieldName]);
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    const offset = Number(body.offset) || 1;
    if (found.length === 0 || offset > found.length) return send(res, 404, { ...msg(401, 'No records match the request'), response: {} });
    return send(res, 200, ok(page(found, offset, Number(body.limit) || undefined, layout, rows.length)));
  }

  if (tail === '/records' && req.method === 'GET') {
    const offset = Number(url.searchParams.get('_offset')) || 1;
    if (offset > rows.length) return send(res, 404, { ...msg(401, 'No records match the request'), response: {} });
    return send(res, 200, ok(page(rows, offset, Number(url.searchParams.get('_limit')) || undefined, layout, rows.length)));
  }
  if (tail === '/records' && req.method === 'POST') {
    const row = { recordId: String(state.nextId++), modId: '0', fieldData: { ...rows[0].fieldData, ...Object.fromEntries(Object.keys(rows[0].fieldData).map((k) => [k, ''])), ...body.fieldData } };
    rows.push(row);
    return send(res, 200, ok({ recordId: row.recordId, modId: row.modId }));
  }
  const rec = tail.match(/^\/records\/([^/]+)$/);
  if (rec) {
    const row = rows.find((r) => r.recordId === rec[1]);
    if (!row) return send(res, 404, msg(101, 'Record is missing'));
    if (req.method === 'GET') return send(res, 200, ok({ data: [row], dataInfo: { database: DB, layout, table: layout, totalRecordCount: rows.length, foundCount: 1, returnedCount: 1 } }));
    if (req.method === 'PATCH') {
      if (body.modId !== undefined && String(body.modId) !== row.modId) return send(res, 500, msg(306, 'Record modification ID does not match'));
      Object.assign(row.fieldData, body.fieldData);
      row.modId = String(Number(row.modId) + 1);
      return send(res, 200, ok({ modId: row.modId }));
    }
    if (req.method === 'DELETE') { rows.splice(rows.indexOf(row), 1); return send(res, 200, ok({})); }
  }
  const script = tail.match(/^\/script\/([^/]+)$/);
  if (script && req.method === 'GET') {
    return send(res, 200, ok({ scriptResult: `ran ${decodeURIComponent(script[1])} param=${url.searchParams.get('script.param') ?? ''}`, scriptError: '0' }));
  }
  return send(res, 404, msg(102, 'Not found in mock'));
});

const port = Number(process.env.PORT ?? 18080);
server.listen(port, '127.0.0.1', () => console.log(`mock FileMaker Data API on http://127.0.0.1:${port} (user ${USER})`));
