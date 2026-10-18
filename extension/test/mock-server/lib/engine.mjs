// Transport-independent core of the mock FileMaker Data API.
//   const engine = createEngine(options);
//   const out = await engine.dispatch({ method, pathname, query, headers, body, protocol });
// `out` is { status, headers, json | buffer | stream }. server.mjs wraps it in HTTP(S); the
// reference proxy (proxy.mjs) and unit tests call it directly. See ENDPOINTS.md for what is
// implemented against the Claris Data API documentation, and what is not.
import crypto from 'node:crypto';

import { buildDataset, DEFAULT_SEED } from './dataset.mjs';
import { cmpVal, runFind } from './find.mjs';
import { parseMultipart } from './multipart.mjs';

export const ACCOUNTS = {
  tester: { password: 'testpass1', write: true, scripts: true, layouts: true },
  // full access like tester (the account a FileMaker administrator would use)
  admin: { password: 'adminpass1', write: true, scripts: true, layouts: true },
  reader: { password: 'readpass1', write: false, scripts: false, layouts: true },
  nobody: { password: 'nopass1', write: false, scripts: false, layouts: false },
  retired: { password: 'retired1', inactive: true },
  // read-only like a privilege set without edit/create/delete: each write is refused with its own code (200, 205, 9)
  viewer: { password: 'viewpass1', write: false, scripts: true, layouts: true, writeCodes: { PATCH: 200, POST: 205, DELETE: 9 }, hiddenFields: ['Email'] },
  // sees one layout only
  limited: { password: 'limitpass1', write: false, scripts: false, layouts: true, layoutAllow: ['Contacts'] }
};
const ACCOUNT_DEFAULTS = JSON.parse(JSON.stringify(ACCOUNTS));
export const OAUTH = { requestId: 'mock-oauth-request', identifier: 'mock-oauth-identifier', user: 'tester' };
export const FMID_TOKEN = 'mock-fmid-token';
export const PROXY_API_KEY = 'mock-proxy-key';

const FM_MESSAGES = {
  0: 'OK', 100: 'File is missing', 200: 'Record access is denied', 205: 'No privilege to create records', 210: 'User account is inactive', 211: 'Password has expired', 214: 'Too many login attempts', 301: 'Record is in use by another user', 956: 'Maximum number of database sessions exceeded', 3: 'Command is invalid (for example, a Set Field script step does not have a calculation specified)', 9: 'Insufficient privileges', 101: 'Record is missing',
  102: 'Field is missing', 104: 'Script is missing', 105: 'Layout is missing', 201: 'Field cannot be modified', 212: 'Invalid user account and/or password; please try again',
  306: 'Record modification ID does not match', 400: 'Find criteria are empty', 401: 'No records match the request', 500: 'Date value does not meet validation entry options',
  502: 'Number value does not meet validation entry options', 504: 'Value in field is not unique', 506: 'Value in field is not a member of the value list',
  509: 'Field requires a valid value', 802: 'Unable to open file', 952: 'Invalid FileMaker Data API token (*)', 960: 'Parameter is invalid', 1633: 'Maximum number of Data API sessions reached (mock approximation)'
};
const HTTP_FOR = { 9: 403, 210: 401, 211: 401, 214: 401, 212: 401, 401: 404, 952: 401, 960: 400, 1633: 503 };

// Field names such as __proto__ must stay ordinary keys.
const setKey = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const safeAssign = (target, source) => { for (const [k, v] of Object.entries(source)) setKey(target, k, v); return target; };
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okBody = (response = {}, extra = {}) => ({ response, messages: [{ code: '0', message: 'OK' }], ...extra });

class ApiError extends Error {
  constructor(code, message, status) {
    super(message ?? FM_MESSAGES[code] ?? 'Error');
    this.code = String(code);
    this.status = status ?? HTTP_FOR[code] ?? 500;
  }
}
const err = (code, message, status) => new ApiError(code, message, status);

function defaultConfig(env = {}) {
  return {
    ttlMs: Number(env.TTL_MS ?? 15 * 60 * 1000),
    maxSessions: Number(env.MAX_SESSIONS ?? 500),
    filterDatabases: env.FILTER_DATABASES === '1',
    cloud: env.CLOUD === '1',
    strictContentType: env.STRICT_CONTENT_TYPE !== '0',
    seed: Number(env.SEED ?? DEFAULT_SEED)
  };
}

export function createEngine(options = {}) {
  const env = options.env ?? {};
  const state = { config: defaultConfig(env), dbs: {}, manifest: null, sessions: new Map(), log: [], sessionPosts: 0, scenario: {}, uploads: new Map(), globals: new Map(), rate: [], requests: 0, faults: [] };
  const MAX_LOG = 1000;

  function reset() {
    const { databases, manifest } = buildDataset(state.config.seed);
    state.dbs = databases;
    state.manifest = manifest;
    state.sessions.clear();
    state.log.length = 0;
    state.sessionPosts = 0;
    state.scenario = parseScenario(env.SCENARIO);
    state.uploads.clear();
    state.globals.clear();
    state.rate.length = 0;
    state.requests = 0;
    state.faults = [];
    for (const [k, v] of Object.entries(ACCOUNT_DEFAULTS)) Object.assign(ACCOUNTS[k], v);
  }
  function parseScenario(text) { try { return text ? JSON.parse(text) : {}; } catch { return {}; } }
  reset();

  // ---- helpers ---------------------------------------------------------------------------
  /** A named fault (see ENDPOINTS.md "Faults"). Returns it when active for this request, consuming one use. */
  function takeFault(name, ctx) {
    const f = state.faults.find((x) => x.name === name && (x.count === undefined || x.count > 0) && (!x.path || new RegExp(x.path).test(ctx?.pathname ?? '')));
    if (!f) return undefined;
    if (f.count !== undefined) f.count -= 1;
    return f;
  }
  const findDb = (name, { exact = false } = {}) => Object.values(state.dbs).find((d) => (exact ? d.name === name : d.name.toLowerCase() === name.toLowerCase()));
  const tableOf = (db, layout) => db.tables[layout.table];
  let currentHidden = [];
  const fieldDefs = (db, layout) => tableOf(db, layout).fields.filter((fd) => layout.fields.includes(fd.name) && !currentHidden.includes(fd.name));
  const nextId = (db, table) => {
    if (db.sharedIdCounter) { db.counter ??= 5000; return String(db.counter++); }
    const id = table.nextRecordId; table.nextRecordId += 1; return String(id);
  };

  function base(ctx) { return `${ctx.protocol}://${ctx.headers.host}`; }
  function expand(value, ctx) {
    if (typeof value !== 'string' || !value.includes('{{')) return value;
    return value.replaceAll('{{BASE}}', base(ctx)).replaceAll('{{HOST}}', ctx.headers.host ?? '').replaceAll('{{TOKEN}}', ctx.token ?? '');
  }

  // Dates are stored as US MM/DD/YYYY (and MM/DD/YYYY HH:MM:SS); dateformats converts on the way out.
  const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2}):(\d{2}))?$/;
  function formatDate(value, fmt) {
    if (typeof value !== 'string' || !fmt) return value;
    const m = US_DATE.exec(value);
    if (!m) return value;
    const [, mo, d, y, h, mi, s] = m;
    const p = (x) => String(x).padStart(2, '0');
    const date = fmt === 2 ? `${y}-${p(mo)}-${p(d)}` : `${p(d)}/${p(mo)}/${y}`;
    return h === undefined ? date : `${date}${fmt === 2 ? 'T' : ' '}${p(h)}:${mi}:${s}`;
  }
  function validDate(text) {
    const m = US_DATE.exec(text);
    if (!m) return false;
    const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 1 || y > 4000 || mo < 1 || mo > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && (m[4] === undefined || (Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60));
  }
  // Accept ISO / locale input according to `dateformats`, normalise to the stored US form.
  function normaliseDateInput(text, fmt) {
    if (typeof text !== 'string') return text;
    if (fmt === 2) {
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?$/.exec(text);
      if (m) return `${m[2]}/${m[3]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}:${m[6]}` : ''}`;
    }
    if (fmt === 1) {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (.*))?$/.exec(text);
      if (m) return `${m[2]}/${m[1]}/${m[3]}${m[4] ? ` ${m[4]}` : ''}`;
    }
    return text;
  }

  // ---- record serialisation --------------------------------------------------------------
  function relatedRows(db, portal, row) {
    const key = row.fieldData[portal.local];
    return db.tables[portal.table].rows.filter((r) => key !== undefined && key !== '' && r.fieldData[portal.foreign] === key);
  }
  function calcValue(db, layout, def, row) {
    const fd = row.fieldData;
    if (def.name === 'FullName') return `${fd.FirstName ?? ''} ${fd.LastName ?? ''}`.trim();
    if (def.name === 'OrderCount') return relatedRows(db, { table: 'Orders', local: 'CustomerID', foreign: 'CustomerID' }, row).length;
    if (def.name === 'TotalOrdered') return Math.round(relatedRows(db, { table: 'Orders', local: 'CustomerID', foreign: 'CustomerID' }, row).reduce((n, r) => n + (Number(r.fieldData.Total) || 0), 0) * 100) / 100;
    if (def.name === 'LineCount') return relatedRows(db, { table: 'LineItems', local: 'OrderID', foreign: 'OrderID' }, row).length;
    return '';
  }
  function serializeFields(db, layout, row, ctx, fmt) {
    const out = {};
    for (const def of fieldDefs(db, layout)) {
      if (def.global) { setKey(out, def.name, state.globals.get(ctx.token)?.[`${layout.table}::${def.name}`] ?? ''); continue; }
      if (def.type !== 'normal') { setKey(out, def.name, calcValue(db, layout, def, row)); continue; }
      const reps = def.repetitions > 1 ? Array.from({ length: def.repetitions }, (_, i) => `${def.name}(${i + 1})`) : [def.name];
      for (const key of reps) {
        if (!Object.hasOwn(row.fieldData, key)) continue; // a field absent from the row is absent from the response
        let v = row.fieldData[key];
        if (def.result === 'date' || def.result === 'timeStamp') v = formatDate(v, fmt);
        setKey(out, key, expand(v, ctx));
      }
    }
    return out;
  }
  function serializeRecord(db, layout, row, ctx, q = {}) {
    const portalData = {};
    const portalInfo = [];
    for (const portal of layout.portals ?? []) {
      if (q.portals && !q.portals.includes(portal.name) && !q.portals.includes(portal.table)) continue;
      const all = relatedRows(db, portal, row);
      const offset = q.portalOffset?.[portal.name] ?? 1;
      const limit = q.portalLimit?.[portal.name] ?? 50;
      const slice = all.slice(offset - 1, offset - 1 + limit);
      portalData[portal.name] = slice.map((r) => {
        const o = {};
        for (const fname of portal.fields) if (Object.hasOwn(r.fieldData, fname)) setKey(o, `${portal.name}::${fname}`, expand(r.fieldData[fname], ctx));
        o.recordId = r.recordId; o.modId = r.modId;
        return o;
      });
      portalInfo.push({ portalObjectName: portal.name, database: db.name, table: portal.table, foundCount: all.length, returnedCount: slice.length });
    }
    return { rec: { recordId: row.recordId, modId: row.modId, fieldData: serializeFields(db, layout, row, ctx, q.fmt), portalData }, portalInfo };
  }
  function recordsResponse(db, layout, allRows, totalRows, rows, ctx, q) {
    const data = []; let portalDataInfo;
    for (const r of rows) { const s = serializeRecord(db, layout, r, ctx, q); data.push(s.rec); portalDataInfo ??= s.portalInfo; }
    const dataInfo = { database: db.name, layout: layout.name, table: layout.table, totalRecordCount: totalRows, foundCount: allRows, returnedCount: data.length };
    if (portalDataInfo?.length) dataInfo.portalDataInfo = portalDataInfo;
    return { data, dataInfo };
  }

  function layoutMeta(def) {
    return {
      name: def.name, type: def.type, displayType: def.valueList ? 'popupMenu' : def.result === 'container' ? 'container' : 'editText', result: def.result,
      global: def.global, autoEnter: Boolean(def.autoEnter), fourDigitYear: false, maxRepeat: def.repetitions, maxCharacters: 0, notEmpty: Boolean(def.notEmpty),
      numeric: def.result === 'number', repetitionStart: 1, repetitionEnd: def.repetitions, timeOfDay: def.result === 'time', ...(def.valueList ? { valueList: def.valueList } : {})
    };
  }

  // ---- scripts ---------------------------------------------------------------------------
  const flattenScripts = (list) => list.flatMap((s) => (s.isFolder ? flattenScripts(s.folderScriptNames ?? []) : [s.name]));
  async function runScript(db, name, param, ctx) {
    if (!flattenScripts(db.scripts).includes(name)) throw err(104);
    if (!ctx.account.scripts) throw err(9);
    // Faults apply to every way of running a script: the dedicated endpoint and the script parameters on record calls.
    if (takeFault('script-slow', ctx)) await sleep(20000);
    if (takeFault('script-error', ctx)) return { result: '', error: '3' };
    if (takeFault('script-huge-result', ctx)) return { result: 'h'.repeat(2 * 1024 * 1024), error: '0' };
    switch (name) {
      case 'Echo': return { result: param ?? '', error: '0' };
      case 'Rebuild Index': return { result: 'ok', error: '0' };
      case 'Fail': return { result: '', error: '3' };
      case 'Slow': await sleep(1500); return { result: 'slow done', error: '0' };
      case 'Count Customers': return { result: String(db.tables.Customers?.rows.length ?? 0), error: '0' };
      case 'Big Result': return { result: 'z'.repeat(1024 * 1024), error: '0' };
      case 'Create Customer': {
        const t = db.tables.Customers; if (!t) return { result: '', error: '105' };
        let p = {}; try { p = param ? JSON.parse(param) : {}; } catch { /* keep {} */ }
        const id = nextId(db, t); t.rows.push({ recordId: id, modId: '0', fieldData: { CustomerID: `C-S${id}`, LastName: 'Scripted', ...p } });
        return { result: id, error: '0' };
      }
      default: return { result: `ran ${name}`, error: '0' };
    }
  }
  async function withScripts(db, params, ctx, work) {
    const extra = {};
    const run = async (kind, nameKey, paramKey, suffix) => {
      const name = params[nameKey]; if (name === undefined) return;
      try { const r = await runScript(db, String(name), params[paramKey], ctx); extra[`scriptResult${suffix}`] = r.result; extra[`scriptError${suffix}`] = r.error; }
      catch (e) { if (e instanceof ApiError && e.code === '104') { extra[`scriptError${suffix}`] = '104'; extra[`scriptResult${suffix}`] = ''; } else throw e; }
    };
    await run('pre', 'script.prerequest', 'script.prerequest.param', '.prerequest');
    const out = await work();
    await run('sort', 'script.presort', 'script.presort.param', '.presort');
    await run('main', 'script', 'script.param', '');
    return { ...out, response: { ...out.response, ...extra } };
  }
  const scriptParamsFrom = (body, query) => {
    const src = { ...Object.fromEntries(query), ...(isPlainObject(body) ? body : {}) };
    return Object.fromEntries(Object.entries(src).filter(([k]) => k.startsWith('script')));
  };

  // ---- write validation ------------------------------------------------------------------
  function validateWrite(db, table, fd, row, options, fmt = 0) {
    if (options?.entrymode === 'script') return;
    for (const [key, raw] of Object.entries(fd)) {
      const name = key.replace(/\(\d+\)$/, '');
      const def = table.fields.find((x) => x.name === name);
      if (!def) throw err(102);
      if (def.type !== 'normal') throw err(201);
      if (def.global) throw err(201);
      const v = raw === null ? '' : raw;
      if ((def.result === 'date' || def.result === 'timeStamp') && v !== '' && !validDate(String(normaliseDateInput(v, fmt)))) throw err(500);
      if (def.result === 'number' && v !== '' && !Number.isFinite(Number(v))) throw err(502);
      if (def.valueList && v !== '' && !db.valueLists[def.valueList]?.includes(String(v))) throw err(506);
      if (def.notEmpty && String(v).trim() === '') throw err(509);
      if (def.unique && v !== '' && table.rows.some((r) => r !== row && r.fieldData[def.name] === String(v))) throw err(504);
    }
  }
  function coerce(db, table, fd, dateformats) {
    const out = {};
    for (const [key, raw] of Object.entries(fd)) {
      const def = table.fields.find((x) => x.name === key.replace(/\(\d+\)$/, ''));
      let v = raw === null || raw === undefined ? '' : raw;
      if (def && (def.result === 'date' || def.result === 'timeStamp')) v = normaliseDateInput(v, dateformats);
      if (def && def.result === 'number' && v !== '' && Number.isFinite(Number(v))) v = Number(v);
      setKey(out, def?.repetitions > 1 && !/\(\d+\)$/.test(key) ? `${key}(1)` : key, v);
    }
    return out;
  }

  // ---- auth ------------------------------------------------------------------------------
  function parseBasic(header) {
    if (!/^Basic /i.test(header ?? '')) return undefined;
    const text = Buffer.from(header.replace(/^Basic /i, ''), 'base64').toString();
    const i = text.indexOf(':');
    return i === -1 ? undefined : [text.slice(0, i), text.slice(i + 1)];
  }
  function authenticate(ctx, db) {
    const h = ctx.headers;
    if (h['x-fm-data-oauth-request-id'] || h['x-fm-data-oauth-identifier']) {
      if (h['x-fm-data-oauth-request-id'] === OAUTH.requestId && h['x-fm-data-oauth-identifier'] === OAUTH.identifier) return { name: OAUTH.user, ...ACCOUNTS[OAUTH.user] };
      throw err(212);
    }
    if (/^FMID /i.test(h.authorization ?? '')) {
      if (!state.config.cloud) throw err(212, 'Claris ID sign-in is only available when the mock runs in cloud mode (CLOUD=1)');
      if (h.authorization.slice(5) === FMID_TOKEN) return { name: 'tester', ...ACCOUNTS.tester };
      throw err(212);
    }
    const basic = parseBasic(h.authorization);
    if (!basic) throw err(212, 'Invalid user account and/or password; please try again', 401);
    const acct = ACCOUNTS[basic[0]];
    if (!acct || acct.password !== basic[1] || acct.inactive) throw err(212);
    return { name: basic[0], ...acct };
  }
  function session(ctx, dbNameInUrl) {
    const token = /^Bearer (.+)$/i.exec(ctx.headers.authorization ?? '')?.[1];
    const s = token && state.sessions.get(token);
    const now = Date.now();
    if (!s) throw err(952);
    if (now - s.lastUsed > state.config.ttlMs) { state.sessions.delete(token); throw err(952); }
    if (dbNameInUrl !== undefined && s.dbName !== dbNameInUrl) throw err(952); // case-sensitive, as documented
    s.lastUsed = now;
    ctx.token = token; ctx.account = s.account;
    return s;
  }

  // ---- routing ---------------------------------------------------------------------------
  const ROUTE = /^\/fmi\/data\/(v1|v2|vLatest)(\/.*)?$/;
  async function route(ctx) {
    const m = ROUTE.exec(ctx.pathname);
    if (!m) throw err(105, 'Not a Data API URL', 404);
    ctx.version = m[1];
    const segs = (m[2] ?? '').split('/').slice(1).map((s) => { try { return decodeURIComponent(s); } catch { throw err(960, 'Malformed URL encoding', 400); } });
    const [a, b, c, d, e, f, g, h] = segs;
    const method = ctx.method;

    if (a === 'productInfo' && segs.length === 1) {
      if (method !== 'GET') throw err(-1, 'Method not allowed', 405);
      return json(okBody({ productInfo: { name: 'FileMaker Data API Engine', buildDate: '09/01/2026', version: '22.0.1', dateFormat: 'MM/dd/yyyy', timeFormat: 'HH:mm:ss', timeStampFormat: 'MM/dd/yyyy HH:mm:ss' } }));
    }
    if (a === 'validateSession' && segs.length === 1) {
      if (method !== 'GET') throw err(-1, 'Method not allowed', 405);
      session(ctx); return json(okBody());
    }
    if (a === 'oauth' && b === 'getoauthurl') {
      if (method !== 'GET') throw err(-1, 'Method not allowed', 405);
      const provider = ctx.query.get('provider');
      if (!provider) throw err(960, 'Parameter is invalid', 400);
      return { status: 200, headers: { 'X-FMS-Request-ID': OAUTH.requestId, 'Content-Type': 'text/plain' }, text: `https://${provider}.example.invalid/oauth/authorize?state=${OAUTH.requestId}` };
    }
    if (a === 'databases' && segs.length === 1) {
      if (method !== 'GET') throw err(-1, 'Method not allowed', 405);
      let visible = Object.values(state.dbs);
      if (state.config.filterDatabases) { const acct = authenticate(ctx); visible = visible.filter((x) => !x.refuses || acct.name === 'tester'); }
      return json(okBody({ databases: visible.map((x) => ({ name: x.name })) }));
    }
    if (a !== 'databases' || b === undefined) throw err(105, 'URL schema is invalid', 404);

    const dbName = b;
    // Sessions: POST /sessions logs in; DELETE /sessions/{token} logs out.
    if (c === 'sessions') {
      if (method === 'POST' && segs.length === 3) return login(ctx, dbName);
      if (method === 'DELETE' && (segs.length === 4 || segs.length === 3)) {
        const token = d ?? /^Bearer (.+)$/i.exec(ctx.headers.authorization ?? '')?.[1];
        state.sessions.delete(token); state.globals.delete(token);
        return json(okBody());
      }
      throw err(-1, 'Method not allowed', 405);
    }
    const s = session(ctx, dbName);
    currentHidden = ctx.account.hiddenFields ?? [];
    const db = findDb(dbName, { exact: true });
    if (!db || db.refuses) throw err(802);

    if (c === 'layouts' && segs.length === 3) {
      if (method !== 'GET') throw err(-1, 'Method not allowed', 405);
      if (!ctx.account.layouts) return json(okBody({ layouts: [] }));
      return json(okBody({ layouts: layoutTree(db, ctx.account.layoutAllow) }));
    }
    if (c === 'scripts' && segs.length === 3) {
      if (method !== 'GET') throw err(-1, 'Method not allowed', 405);
      return json(okBody({ scripts: db.scripts }));
    }
    if (c === 'globals' && segs.length === 3) {
      if (method !== 'PATCH') throw err(-1, 'Method not allowed', 405);
      needJson(ctx);
      const gf = ctx.body?.globalFields;
      if (!isPlainObject(gf)) throw err(960, 'Parameter is invalid', 400);
      const mine = state.globals.get(ctx.token) ?? {};
      for (const [k, v] of Object.entries(gf)) {
        const [tbl, fld] = k.split('::');
        const def = db.tables[tbl]?.fields.find((x) => x.name === fld);
        if (!def || !def.global) throw err(102);
        mine[k] = v;
      }
      state.globals.set(ctx.token, mine);
      return json(okBody());
    }
    if (c !== 'layouts' || d === undefined) throw err(105, 'URL schema is invalid', 404);
    if (!ctx.account.layouts) throw err(105);
    const layout = db.layouts.find((x) => x.name === d);
    if (!layout || (ctx.account.layoutAllow && !ctx.account.layoutAllow.includes(layout.name))) throw err(105);
    const table = tableOf(db, layout);

    if (e === undefined) {
      if (method !== 'GET') throw err(-1, 'Method not allowed', 405);
      const defs = fieldDefs(db, layout);
      const used = [...new Set(defs.map((x) => x.valueList).filter(Boolean))];
      return json(okBody({
        fieldMetaData: defs.map(layoutMeta),
        portalMetaData: Object.fromEntries((layout.portals ?? []).map((p) => [p.name, db.tables[p.table].fields.filter((x) => p.fields.includes(x.name)).map((x) => ({ ...layoutMeta(x), name: `${p.name}::${x.name}` }))])),
        valueLists: used.map((n) => ({ name: n, type: 'customList', values: db.valueLists[n].map((v) => ({ displayValue: v, value: v })) }))
      }));
    }
    if (e === '_find') {
      if (method !== 'POST') throw err(-1, 'Method not allowed', 405);
      needJson(ctx);
      return find(ctx, db, layout, table);
    }
    if (e === 'script' && f !== undefined && segs.length === 6) {
      if (method !== 'GET') throw err(-1, 'Method not allowed', 405);
      const r = await runScript(db, f, ctx.query.get('script.param') ?? undefined, ctx);
      return json(okBody({ scriptResult: r.result, scriptError: r.error }));
    }
    if (e !== 'records') throw err(105, 'URL schema is invalid', 404);
    if (f === undefined) {
      if (method === 'GET') return listRecords(ctx, db, layout, table);
      if (method === 'POST') { needJson(ctx); needWrite(ctx); return createRecord(ctx, db, layout, table); }
      throw err(-1, 'Method not allowed', 405);
    }
    const recordId = f;
    if (g === 'containers' && h !== undefined && method === 'POST') { needWrite(ctx); return uploadContainer(ctx, db, layout, table, recordId, h, segs[8]); }
    if (g !== undefined) throw err(105, 'URL schema is invalid', 404);
    if (method === 'GET') {
      const row = table.rows.find((r) => r.recordId === recordId);
      if (!row) throw err(101);
      return withScripts(db, scriptParamsFrom(undefined, ctx.query), ctx, async () => ({ response: recordsResponse(db, layout, 1, table.rows.length, [row], ctx, readQuery(ctx.query)) })).then((r) => json(okBody(r.response)));
    }
    needWrite(ctx);
    if (method === 'PATCH') { needJson(ctx); return editRecord(ctx, db, layout, table, recordId); }
    if (method === 'DELETE') return deleteRecord(ctx, db, layout, table, recordId);
    if (method === 'POST') return duplicateRecord(ctx, db, layout, table, recordId);
    throw err(-1, 'Method not allowed', 405);
  }

  function layoutTree(db, allow) {
    const root = [];
    const folderAt = (path) => {
      let list = root; let node;
      for (const name of path) {
        node = list.find((x) => x.isFolder && x.name === name);
        if (!node) { node = { name, isFolder: true, folderLayoutNames: [] }; list.push(node); }
        list = node.folderLayoutNames;
      }
      return list;
    };
    for (const l of db.layouts) if (!allow || allow.includes(l.name)) folderAt(l.folder ?? []).push({ name: l.name });
    return root;
  }
  const needJson = (ctx) => {
    if (state.config.strictContentType && ctx.rawBody.length > 0 && !/^application\/json/i.test(ctx.headers['content-type'] ?? '')) throw err(-1, 'Unsupported media type: Content-Type must be application/json', 415);
    if (ctx.rawBody.length > 0 && !isPlainObject(ctx.body)) throw err(960, 'Parameter is invalid', 400);
  };
  const needWrite = (ctx) => {
    if (ctx.account.write) return;
    const code = ctx.account.writeCodes?.[ctx.method] ?? 9;
    throw err(code);
  };

  function login(ctx, dbName) {
    state.sessionPosts += 1;
    needJson(ctx);
    const db = findDb(dbName);
    if (takeFault('login-inactive', ctx)) throw err(210);
    if (takeFault('login-expired-password', ctx)) throw err(211);
    if (takeFault('login-locked', ctx)) throw err(214);
    if (takeFault('login-no-fmrest', ctx)) throw err(802);
    if (takeFault('login-session-limit', ctx)) throw err(956);
    const nh = takeFault('db-not-hosted', ctx);
    if (nh) throw nh.variant === '401' ? err(212) : err(100);
    if (!db || db.refuses) throw err(802);
    const account = authenticate(ctx, db);
    if (state.sessions.size >= state.config.maxSessions) throw err(1633);
    const token = crypto.randomBytes(32).toString('hex');
    state.sessions.set(token, { dbName: db.name, account, lastUsed: Date.now(), createdAt: Date.now() });
    return { status: 200, headers: { 'X-FM-Data-Access-Token': token }, json: okBody({ token }) };
  }

  function readQuery(q, body = {}) {
    const get = (k) => (body[k] !== undefined ? body[k] : q.get(k) ?? undefined);
    const portalsRaw = get('portal');
    let portals;
    if (portalsRaw !== undefined) { try { portals = typeof portalsRaw === 'string' ? JSON.parse(portalsRaw) : portalsRaw; } catch { throw err(960, 'Parameter is invalid', 400); } if (!Array.isArray(portals)) throw err(960, 'Parameter is invalid', 400); }
    const portalOffset = {}; const portalLimit = {};
    const keys = new Set([...q.keys(), ...Object.keys(body)]);
    for (const k of keys) {
      const mm = /^_?(offset|limit)\.(.+)$/.exec(k);
      if (!mm) continue;
      const n = Number(get(k)); if (!Number.isInteger(n) || n < 1) throw err(960, 'Parameter is invalid', 400);
      (mm[1] === 'offset' ? portalOffset : portalLimit)[mm[2]] = n;
    }
    const df = get('dateformats') ?? get('_dateformats');
    const fmt = df === undefined ? 0 : Number(df);
    if (![0, 1, 2].includes(fmt)) throw err(960, 'Parameter is invalid', 400);
    return { portals, portalOffset, portalLimit, fmt };
  }
  function intParam(raw, def) {
    if (raw === undefined || raw === null || raw === '') return def;
    const n = Number(raw); if (!Number.isInteger(n) || n < 1) throw err(960, 'Parameter is invalid', 400);
    return n;
  }
  function resolveResponseLayout(ctx, db, layout, body) {
    const name = body?.['layout.response'] ?? ctx.query.get('layout.response');
    if (!name) return layout;
    const l = db.layouts.find((x) => x.name === name); if (!l) throw err(105);
    return l;
  }

  function sortRows(rows, sortSpec, db, layout, table) {
    let out = rows;
    for (const s of [...sortSpec].reverse()) {
      if (!isPlainObject(s) || typeof s.fieldName !== 'string') throw err(960, 'Parameter is invalid', 400);
      if (!table.fields.some((x) => x.name === s.fieldName.replace(/\(\d+\)$/, '')) && !s.fieldName.includes('::')) throw err(102);
      const list = s.sortOrder && !['ascend', 'descend'].includes(s.sortOrder) ? db.valueLists[s.sortOrder] : undefined;
      const dir = s.sortOrder === 'descend' ? -1 : 1;
      const val = (r) => cmpVal(r.fieldData[s.fieldName]);
      out = [...out].sort((a, b) => {
        if (list) return (list.indexOf(String(a.fieldData[s.fieldName])) - list.indexOf(String(b.fieldData[s.fieldName])));
        const x = val(a); const y = val(b);
        return (typeof x === typeof y ? (x < y ? -1 : x > y ? 1 : 0) : String(x).localeCompare(String(y))) * dir;
      });
    }
    return out;
  }

  async function listRecords(ctx, db, layout, table) {
    const q = readQuery(ctx.query);
    const offset = intParam(ctx.query.get('_offset'), 1);
    const limit = intParam(ctx.query.get('_limit'), 100);
    let sortSpec = [];
    if (ctx.query.has('_sort')) { try { sortSpec = JSON.parse(ctx.query.get('_sort')); } catch { throw err(960, 'Parameter is invalid', 400); } if (!Array.isArray(sortSpec)) throw err(960, 'Parameter is invalid', 400); }
    const respLayout = resolveResponseLayout(ctx, db, layout, undefined);
    return withScripts(db, scriptParamsFrom(undefined, ctx.query), ctx, async () => {
      const rows = sortRows(table.rows, sortSpec, db, layout, table);
      if (rows.length === 0 || offset > rows.length) throw err(401, undefined, takeFault('find-no-match-500', ctx) ? 500 : undefined);
      return { response: recordsResponse(db, respLayout, rows.length, table.rows.length, rows.slice(offset - 1, offset - 1 + limit), ctx, q) };
    }).then((r) => json(okBody(r.response)));
  }

  async function find(ctx, db, layout, table) {
    const body = ctx.body ?? {};
    if (!Array.isArray(body.query) || !body.query.every(isPlainObject)) throw err(960, 'Find query is invalid');
    if (body.query.length === 0) throw err(400);
    const q = readQuery(ctx.query, body);
    const offset = intParam(body.offset, 1); const limit = intParam(body.limit, 100);
    const respLayout = resolveResponseLayout(ctx, db, layout, body);
    const relatedTable = (name) => layout.portals?.find((p) => p.table === name.split('::')[0] || p.name === name.split('::')[0]);
    const valueOf = (row, field) => {
      if (field.includes('::')) {
        const portal = relatedTable(field);
        if (!portal) throw err(102);
        return relatedRows(db, portal, row).map((r) => r.fieldData[field.split('::')[1]]);
      }
      const base0 = field.replace(/\(\d+\)$/, '');
      const def = table.fields.find((x) => x.name === base0);
      if (!def) throw err(102);
      if (def.global) throw err(102, 'Global fields cannot be used as find criteria');
      if (def.type !== 'normal') return calcValue(db, layout, def, row);
      return row.fieldData[field] ?? row.fieldData[`${field}(1)`];
    };
    return withScripts(db, scriptParamsFrom(body, ctx.query), ctx, async () => {
      let found = runFind(table.rows, body.query, valueOf);
      found = sortRows(found, Array.isArray(body.sort) ? body.sort : [], db, layout, table);
      if (found.length === 0 || offset > found.length) throw err(401, undefined, takeFault('find-no-match-500', ctx) ? 500 : undefined);
      return { response: recordsResponse(db, respLayout, found.length, table.rows.length, found.slice(offset - 1, offset - 1 + limit), ctx, q) };
    }).then((r) => json(okBody(r.response)));
  }

  function recordFaults(ctx, fd) {
    if (takeFault('record-locked', ctx)) throw err(301);
    if (takeFault('record-gone', ctx)) throw err(101);
    if (takeFault('validation-fail', ctx)) throw err(509);
    const ro = state.faults.find((x) => x.name === 'field-readonly' && (x.count === undefined || x.count > 0) && fd && Object.keys(fd).includes(x.field ?? 'Amount'));
    if (ro) { if (ro.count !== undefined) ro.count -= 1; throw err(201); }
  }
  async function createRecord(ctx, db, layout, table) {
    const body = ctx.body ?? {};
    recordFaults(ctx, body.fieldData);
    if (body.fieldData !== undefined && !isPlainObject(body.fieldData)) throw err(960, 'Parameter is invalid', 400);
    const fmt = Number(body.dateformats ?? 0);
    const fd = body.fieldData ?? {};
    for (const k of Object.keys(fd)) if (!layout.fields.includes(k.replace(/\(\d+\)$/, ''))) throw err(102);
    validateWrite(db, table, fd, undefined, body.options, fmt);
    const id = nextId(db, table);
    const fieldData = Object.fromEntries(table.fields.filter((x) => x.type === 'normal' && !x.global).flatMap((x) => (x.repetitions > 1 ? Array.from({ length: x.repetitions }, (_, i) => [`${x.name}(${i + 1})`, '']) : [[x.name, x.autoEnter && x.unique ? `${table.name[0]}-${id}` : '']])));
    safeAssign(fieldData, coerce(db, table, fd, fmt));
    const row = { recordId: id, modId: '0', fieldData };
    table.rows.push(row);
    if (isPlainObject(body.portalData)) applyPortalData(db, layout, row, body.portalData, fmt, body.options);
    return withScripts(db, scriptParamsFrom(body, ctx.query), ctx, async () => ({ response: { recordId: row.recordId, modId: row.modId } })).then((r) => json(okBody(r.response)));
  }

  function applyPortalData(db, layout, row, portalData, fmt, options) {
    for (const [pname, list] of Object.entries(portalData)) {
      const portal = (layout.portals ?? []).find((p) => p.name === pname || p.table === pname);
      if (!portal || !Array.isArray(list)) throw err(102);
      const t = db.tables[portal.table];
      for (const item of list) {
        if (!isPlainObject(item)) throw err(960, 'Parameter is invalid', 400);
        const { recordId, modId, ...rest } = item;
        const fields = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k.includes('::') ? k.split('::')[1] : k, v]));
        if (recordId !== undefined) {
          const r = t.rows.find((x) => x.recordId === String(recordId));
          if (!r) throw err(101);
          if (modId !== undefined && String(modId) !== r.modId) throw err(306);
          validateWrite(db, t, fields, r, options, fmt);
          safeAssign(r.fieldData, coerce(db, t, fields, fmt)); r.modId = String(Number(r.modId) + 1);
        } else {
          validateWrite(db, t, fields, undefined, options, fmt);
          const nr = { recordId: nextId(db, t), modId: '0', fieldData: { ...Object.fromEntries(t.fields.map((x) => [x.name, ''])), [portal.foreign]: row.fieldData[portal.local], ...coerce(db, t, fields, fmt) } };
          t.rows.push(nr);
        }
      }
    }
  }

  async function editRecord(ctx, db, layout, table, recordId) {
    const body = ctx.body ?? {};
    recordFaults(ctx, body.fieldData);
    const row = table.rows.find((r) => r.recordId === recordId);
    if (!row) throw err(101);
    if (body.fieldData !== undefined && !isPlainObject(body.fieldData)) throw err(960, 'Parameter is invalid', 400);
    if (body.modId !== undefined && String(body.modId) !== row.modId) throw err(306);
    const fmt = Number(body.dateformats ?? 0);
    const fd = body.fieldData ?? {};
    for (const k of Object.keys(fd)) if (!layout.fields.includes(k.replace(/\(\d+\)$/, ''))) throw err(102);
    validateWrite(db, table, fd, row, body.options, fmt);
    // Validate everything before touching the row so a failure leaves it unchanged.
    const update = coerce(db, table, fd, fmt);
    safeAssign(row.fieldData, update);
    if (isPlainObject(body.portalData)) applyPortalData(db, layout, row, body.portalData, fmt, body.options);
    if (body.deleteRelated !== undefined) {
      for (const spec of [].concat(body.deleteRelated)) {
        const [pname, rid] = String(spec).split('.');
        const portal = (layout.portals ?? []).find((p) => p.name === pname || p.table === pname);
        if (!portal) throw err(102);
        const t = db.tables[portal.table]; const i = t.rows.findIndex((r) => r.recordId === rid);
        if (i === -1) throw err(101);
        t.rows.splice(i, 1);
      }
    }
    row.modId = String(Number(row.modId) + 1);
    const se = takeFault('script-error-after-edit', ctx);
    return withScripts(db, scriptParamsFrom(body, ctx.query), ctx, async () => ({ response: { modId: row.modId, ...(se ? { scriptError: '3', scriptResult: '' } : {}) } })).then((r) => json(okBody(r.response)));
  }

  async function deleteRecord(ctx, db, layout, table, recordId) {
    recordFaults(ctx, undefined);
    const i = table.rows.findIndex((r) => r.recordId === recordId);
    if (i === -1) throw err(101);
    table.rows.splice(i, 1);
    return withScripts(db, scriptParamsFrom(undefined, ctx.query), ctx, async () => ({ response: {} })).then((r) => json(okBody(r.response)));
  }

  async function duplicateRecord(ctx, db, layout, table, recordId) {
    const src = table.rows.find((r) => r.recordId === recordId);
    if (!src) throw err(101);
    const id = nextId(db, table);
    const copy = structuredClone(src.fieldData);
    for (const def of table.fields) if (def.unique && Object.hasOwn(copy, def.name)) copy[def.name] = `${table.name[0]}-${id}`;
    table.rows.push({ recordId: id, modId: '0', fieldData: copy });
    return withScripts(db, scriptParamsFrom(ctx.body, ctx.query), ctx, async () => ({ response: { recordId: id, modId: '0' } })).then((r) => json(okBody(r.response)));
  }

  function uploadContainer(ctx, db, layout, table, recordId, fieldName, repetitionRaw) {
    const ct = ctx.headers['content-type'] ?? '';
    if (!/^multipart\/form-data/i.test(ct) || !/boundary=/i.test(ct)) throw err(-1, 'Unsupported media type: Content-Type must be multipart/form-data with a boundary', 415);
    const row = table.rows.find((r) => r.recordId === recordId);
    if (!row) throw err(101);
    const def = table.fields.find((x) => x.name === fieldName);
    if (!def || !layout.fields.includes(fieldName) || def.result !== 'container') throw err(102);
    const rep = repetitionRaw === undefined ? 1 : Number(repetitionRaw);
    if (!Number.isInteger(rep) || rep < 1 || rep > def.repetitions) throw err(960, 'Parameter is invalid', 400);
    if (ctx.query.has('modId') && ctx.query.get('modId') !== row.modId) throw err(306);
    const parts = parseMultipart(ct, ctx.rawBody) ?? [];
    const part = parts.find((p) => p.name === 'upload');
    if (!part) throw err(960, 'Parameter is invalid (the file must be sent as a part named "upload")', 400);
    const key = `upload-${state.uploads.size + 1}-${(part.filename ?? 'file').replace(/[^\w.-]/g, '_')}`;
    state.uploads.set(key, { bytes: part.data, type: part.type ?? 'application/octet-stream', fileName: part.filename });
    row.fieldData[def.repetitions > 1 ? `${fieldName}(${rep})` : fieldName] = `/Streaming_SSL/MainDB/${key}?RCType=EmbeddedRCFileProcessor`;
    row.modId = String(Number(row.modId) + 1);
    return json(okBody());
  }

  // ---- streaming (container data) --------------------------------------------------------
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  function streaming(ctx) {
    const cookie = /(?:^|;\s*)X-FM-Data-Access-Token=([^;]+)/.exec(ctx.headers.cookie ?? '')?.[1];
    if (!cookie || !state.sessions.has(cookie)) return { status: 401, headers: { 'Content-Type': 'text/plain' }, text: 'Invalid token' };
    const name = decodeURIComponent(ctx.pathname.replace('/Streaming_SSL/MainDB/', ''));
    if (name.includes('..') || name.includes('\0') || name.includes('/')) return { status: 404, headers: { 'Content-Type': 'text/plain' }, text: 'Not found' };
    if (name.startsWith('huge')) return { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(25 * 1024 * 1024) }, stream: { size: 25 * 1024 * 1024 } };
    const up = state.uploads.get(name);
    if (up) return { status: 200, headers: { 'Content-Type': up.type }, buffer: up.bytes };
    if (/\.(png)$/i.test(name) || name.startsWith('avatar') || name.startsWith('thumb')) return { status: 200, headers: { 'Content-Type': 'image/png' }, buffer: PNG };
    if (/\.pdf$/i.test(name)) return { status: 200, headers: { 'Content-Type': 'application/pdf' }, buffer: Buffer.from('%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') };
    return { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, buffer: Buffer.from('mock container bytes') };
  }

  const json = (body, status = 200, headers = {}) => ({ status, headers, json: body });

  // ---- scenario / failure injection ------------------------------------------------------
  async function applyScenario(ctx) {
    const sc = state.scenario;
    const slow = takeFault('slow', ctx);
    if (slow) await sleep(slow.delayMs ?? 20000);
    if (sc.delayMs) await sleep(sc.delayMs);
    if (sc.hang && new RegExp(sc.hang).test(ctx.pathname)) return { hang: true };
    if (sc.drop && new RegExp(sc.drop).test(ctx.pathname)) return { drop: true };
    if (sc.rateLimit) {
      const now = Date.now(); state.rate = state.rate.filter((t) => now - t < (sc.rateLimit.windowMs ?? 60000)); state.rate.push(now);
      if (state.rate.length > sc.rateLimit.limit) return { status: 429, headers: { 'Retry-After': '1' }, json: { messages: [{ code: '-1', message: 'Too many requests (mock rate limit)' }] } };
    }
    for (const rule of sc.failNext ?? []) {
      if (rule.count <= 0) continue;
      const mt = rule.match ?? {};
      if (mt.method && mt.method !== ctx.method) continue;
      if (mt.path && !new RegExp(mt.path).test(ctx.pathname)) continue;
      rule.count -= 1;
      return { status: rule.status ?? 500, headers: {}, json: { messages: [{ code: String(rule.code ?? '1'), message: rule.message ?? 'Injected failure' }] } };
    }
    return undefined;
  }

  const HTML_PAGE = '<!DOCTYPE html><html><head><title>Sign in</title></head><body><h1>Sign in to continue</h1><p>Internal gateway fm-gw-01.corp.example</p></body></html>';
  function gatewayFault(ctx) {
    if (!ctx.pathname.startsWith('/fmi/data')) return undefined;
    const html = (status, headers = {}) => ({ status, headers: { 'Content-Type': 'text/html', ...headers }, text: HTML_PAGE });
    let f;
    if ((f = takeFault('data-api-disabled', ctx))) return { status: 404, headers: { 'Content-Type': 'text/html' }, text: '<html><body><h1>404 Not Found</h1></body></html>' };
    if ((f = takeFault('html-200', ctx))) return html(200);
    if ((f = takeFault('empty-200', ctx))) return { status: 200, headers: { 'Content-Type': 'application/json' }, text: '' };
    if ((f = takeFault('truncated-json', ctx))) return { status: 200, headers: { 'Content-Type': 'application/json' }, text: '{"response":{"tok' };
    if ((f = takeFault('array-body', ctx))) return { status: 200, headers: { 'Content-Type': 'application/json' }, text: '[]' };
    if ((f = takeFault('redirect-login', ctx))) return { status: 302, headers: { Location: '/login', 'Content-Type': 'text/html' }, text: '' };
    if ((f = takeFault('redirect-other-origin', ctx))) return { status: 307, headers: { Location: `${f.target ?? 'http://127.0.0.1:9'}${ctx.pathname}`, 'Content-Type': 'text/html' }, text: '' };
    for (const code of [413, 429, 502, 503, 504]) if ((f = takeFault(`status-${code}`, ctx))) return html(code, code === 429 ? { 'Retry-After': String(f.retryAfter ?? 2) } : {});
    if ((f = takeFault('drop-mid-response', ctx))) return { dropMid: true, partial: '{"response":{"data":[{"recordId":"1","fieldData":{"A":"' };
    if ((f = takeFault('reset-connection', ctx))) return { drop: true };
    return undefined;
  }
  // ---- public dispatch --------------------------------------------------------------------
  async function dispatch(input) {
    const started = Date.now();
    const ctx = {
      method: input.method, pathname: input.pathname, query: input.query ?? new URLSearchParams(), headers: input.headers ?? {}, protocol: input.protocol ?? 'http',
      rawBody: input.body ?? Buffer.alloc(0), body: undefined
    };
    if (/^application\/json/i.test(ctx.headers['content-type'] ?? '') || (ctx.rawBody.length && !/multipart/i.test(ctx.headers['content-type'] ?? ''))) {
      try { ctx.body = ctx.rawBody.length ? JSON.parse(ctx.rawBody.toString('utf8')) : {}; } catch { ctx.body = Symbol.for('invalid'); }
    }
    const host = (ctx.headers.host ?? '').replace(/:\d+$/, '');
    let out; let code = '0';
    state.requests += 1;
    try {
      // Only answer requests addressed to this machine, so a web page that rebinds DNS to
      // 127.0.0.1 cannot drive the server.
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { out = json({ messages: [{ code: '0', message: 'Forbidden host' }] }, 403); }
      else if (ctx.body === Symbol.for('invalid')) { ctx.body = undefined; out = json({ messages: [{ code: '960', message: 'Malformed JSON body' }] }, 400); }
      else if (ctx.method === 'OPTIONS') { out = json({ messages: [{ code: '-1', message: 'Method not allowed (CORS and OPTIONS are not supported)' }] }, 405); }
      else if (ctx.pathname.startsWith('/Streaming_SSL/')) { out = streaming(ctx); }
      else if ((out = gatewayFault(ctx))) { /* injected gateway behaviour */ }
      else {
        const injected = await applyScenario(ctx);
        if (injected) out = injected;
        else {
          out = await route(ctx);
          const nz = out.status === 200 && out.json?.messages ? takeFault('messages-nonzero-200', ctx) : undefined;
          if (nz) out = { ...out, json: { ...out.json, messages: [{ code: String(nz.code ?? '212'), message: FM_MESSAGES[nz.code ?? 212] ?? 'Error' }] } };
        }
      }
    } catch (e) {
      if (e instanceof ApiError) { out = json({ messages: [{ code: e.code, message: e.message }], ...(e.code === '401' ? { response: {} } : {}) }, e.status); code = e.code; }
      else { out = json({ messages: [{ code: '1', message: `Mock server error: ${e.message}` }] }, 500); code = '1'; }
    }
    // Expired-session clean-up and request log.
    const dbMatch = /^\/fmi\/data\/[^/]+\/databases\/([^/]+)/.exec(ctx.pathname);
    const shown = dbMatch ? ctx.pathname.replace(dbMatch[0], '') : ctx.pathname;
    const entry = { method: ctx.method, path: shown, query: ctx.query.toString() ? `?${ctx.query.toString()}` : '', db: dbMatch ? decodeURIComponent(dbMatch[1]) : undefined, status: out.status, code: out.json?.messages?.[0]?.code ?? code, ms: Date.now() - started };
    if (ctx.body && typeof ctx.body === 'object' && Object.keys(ctx.body).length) entry.body = truncate(ctx.body);
    state.log.push(entry);
    if (state.log.length > MAX_LOG) state.log.shift();
    return out;
  }
  const truncate = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 500 ? `${x.slice(0, 500)}...(${x.length} chars)` : x)));

  // ---- admin ------------------------------------------------------------------------------
  function admin(method, pathname, query, body) {
    const ok = (b = {}) => ({ status: 200, json: b });
    if (pathname === '/__admin/log' && method === 'GET') {
      const limit = Number(query.get('limit') ?? MAX_LOG);
      return ok({ log: state.log.slice(-limit), sessionPosts: state.sessionPosts });
    }
    if (pathname === '/__admin/state' && method === 'GET') return ok({ liveSessions: [...state.sessions.values()].map((x) => ({ db: x.dbName, user: x.account.name, ageMs: Date.now() - x.createdAt })), sessions: state.sessions.size, requests: state.requests, sessionPosts: state.sessionPosts, config: state.config, scenario: state.scenario, totals: state.manifest.totals });
    if (pathname === '/__admin/manifest' && method === 'GET') return ok(state.manifest);
    if (pathname === '/__admin/faults' && method === 'GET') return ok({ faults: state.faults });
    if (method !== 'POST') return { status: pathname.startsWith('/__admin/') ? 405 : 404, json: {} };
    switch (pathname) {
      case '/__admin/reset': reset(); return ok();
      case '/__admin/expire': // forget one or every token (next request gets HTTP 401 / code 952)
        if (body?.token) state.sessions.delete(body.token); else state.sessions.clear();
        return ok();
      case '/__admin/age': // make sessions look older without waiting: { ms }
        for (const s of state.sessions.values()) s.lastUsed -= Number(body?.ms ?? state.config.ttlMs + 1);
        return ok();
      case '/__admin/config': Object.assign(state.config, pick(body, ['ttlMs', 'maxSessions', 'filterDatabases', 'cloud', 'strictContentType'])); return ok(state.config);
      case '/__admin/fault': // { name, count?, path?, ...params } adds a named fault; { clear: true } removes all
        if (body?.clear) state.faults = []; else state.faults.push({ ...body });
        return ok({ faults: state.faults });
      case '/__admin/account': { // change an account: { name, password?, inactive? } (e.g. the stored password goes bad)
        const a = ACCOUNTS[body.name]; if (!a) return { status: 404, json: { error: 'no such account' } };
        Object.assign(a, pick(body, ['password', 'inactive', 'write', 'scripts', 'layouts']));
        return ok({ name: body.name });
      }
      case '/__admin/reset-accounts': for (const [k, v] of Object.entries(ACCOUNT_DEFAULTS)) Object.assign(ACCOUNTS[k], v); return ok();
      case '/__admin/many': { // create a layout "Big" with n simple records: { db, n }
        const db = state.dbs[body.db ?? 'Quality'];
        const fields = [{ name: 'N', result: 'number', type: 'normal', repetitions: 1, global: false }, { name: 'Label', result: 'text', type: 'normal', repetitions: 1, global: false }];
        const rows = Array.from({ length: body.n }, (_, i) => ({ recordId: String(i + 1), modId: '0', fieldData: { N: i + 1, Label: `row ${i + 1}` } }));
        db.tables.Big = { name: 'Big', fields, rows, nextRecordId: body.n + 1 };
        db.layouts = db.layouts.filter((l) => l.name !== 'Big'); db.layouts.push({ name: 'Big', table: 'Big', fields: ['N', 'Label'] });
        return ok({ rows: rows.length });
      }
      case '/__admin/scenario': // merge scenario switches; { "clear": true } removes them
        state.scenario = body?.clear ? {} : { ...state.scenario, ...body };
        return ok(state.scenario);
      case '/__admin/concurrent-edit': { // another user changes a record: bumps modId so the next edit conflicts
        const row = adminRow(body); safeAssign(row.fieldData, body.fieldData ?? {}); row.modId = String(Number(row.modId) + 1);
        return ok({ recordId: row.recordId, modId: row.modId });
      }
      case '/__admin/schema': { // change a layout's schema: { db, table, addField: {name,result}, removeField: name, rename: {from,to}, layouts: [names] }
        const db = state.dbs[body.db]; const t = db.tables[body.table];
        const targets = db.layouts.filter((l) => l.table === body.table && (!body.layouts || body.layouts.includes(l.name)));
        if (body.addField) { t.fields.push({ name: body.addField.name, result: body.addField.result ?? 'text', type: 'normal', repetitions: 1, global: false }); for (const r of t.rows) r.fieldData[body.addField.name] = ''; for (const l of targets) l.fields.push(body.addField.name); }
        if (body.removeField) { t.fields = t.fields.filter((f) => f.name !== body.removeField); for (const l of targets) l.fields = l.fields.filter((n) => n !== body.removeField); }
        if (body.removeLayoutsLongerThan !== undefined) db.layouts = db.layouts.filter((l) => l.name.length <= body.removeLayoutsLongerThan);
        if (body.rename) { for (const l of db.layouts) if (l.name === body.rename.from) l.name = body.rename.to; }
        return ok({ fields: t.fields.length });
      }
      case '/__admin/concurrent-delete': {
        const t = state.dbs[body.db].tables[body.table]; const i = t.rows.findIndex((r) => r.recordId === String(body.recordId));
        if (i === -1) return { status: 404, json: { error: 'no such record' } };
        t.rows.splice(i, 1); return ok();
      }
      default: return { status: 404, json: {} };
    }
  }
  const adminRow = (b) => {
    const t = state.dbs[b.db]?.tables[b.table];
    const row = t?.rows.find((r) => r.recordId === String(b.recordId));
    if (!row) throw new Error('no such record');
    return row;
  };
  const pick = (o = {}, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

  return { state, dispatch, admin, reset, ACCOUNTS, internals: { findDb, runScript } };
}
