import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { api, basicAuth, type RunningMock, startMockProcess } from './mockHelper';

// Contract tests: the mock's responses against the shapes printed in the Claris Data API Guide
// (https://help.claris.com/en/data-api-guide/), see extension/scripts/mock/ENDPOINTS.md for the
// per-topic URLs. Claris publishes no downloadable OpenAPI file, so the shapes below are
// transcribed from those pages (the OpenAPI viewer ships with FileMaker Server and was not available).

const ok = z.object({ code: z.literal('0'), message: z.literal('OK') });
const envelope = <T extends z.ZodTypeAny>(response: T) =>
  z.object({ response, messages: z.tuple([ok]) });
const fieldMeta = z.object({
  name: z.string(),
  type: z.string(),
  displayType: z.string(),
  result: z.string(),
  global: z.boolean(),
  autoEnter: z.boolean(),
  fourDigitYear: z.boolean(),
  maxRepeat: z.number(),
  maxCharacters: z.number(),
  notEmpty: z.boolean(),
  numeric: z.boolean(),
  repetitionStart: z.number(),
  repetitionEnd: z.number(),
  timeOfDay: z.boolean()
});
const record = z.object({
  recordId: z.string(),
  modId: z.string(),
  fieldData: z.record(z.string(), z.unknown()),
  portalData: z.record(z.string(), z.array(z.record(z.string(), z.unknown())))
});
const dataInfo = z
  .object({
    database: z.string(),
    layout: z.string(),
    table: z.string(),
    totalRecordCount: z.number(),
    foundCount: z.number(),
    returnedCount: z.number()
  })
  .passthrough();
const layoutNode: z.ZodType = z.lazy(() =>
  z.object({
    name: z.string(),
    isFolder: z.boolean().optional(),
    folderLayoutNames: z.array(layoutNode).optional()
  })
);
const scriptNode: z.ZodType = z.lazy(() =>
  z.object({
    name: z.string(),
    isFolder: z.boolean(),
    folderScriptNames: z.array(scriptNode).optional()
  })
);

let mock: RunningMock;
let http: ReturnType<typeof api>;
let token: string;

beforeAll(async () => {
  mock = await startMockProcess();
  http = api(mock.baseUrl);
  token = (await http.login()).token;
}, 30000);
afterAll(async () => mock?.stop());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin = async (route: string, body?: unknown): Promise<any> =>
  (
    await fetch(mock.adminUrl + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  ).json();
const L = (name: string) => `/databases/Quality/layouts/${encodeURIComponent(name)}`;

describe('documented response shapes', () => {
  it('login returns the token in the body and the X-FM-Data-Access-Token header', async () => {
    const r = await http.call('POST', '/databases/Quality/sessions', {
      body: {},
      headers: { Authorization: basicAuth() }
    });
    expect(r.status).toBe(200);
    envelope(z.object({ token: z.string().min(20) })).parse(r.body);
    expect(r.headers.get('x-fm-data-access-token')).toBe(r.body.response.token);
  });
  it('productInfo (no auth) and databases', async () => {
    const info = await http.call('GET', '/productInfo');
    envelope(
      z.object({
        productInfo: z
          .object({
            name: z.string(),
            dateFormat: z.string(),
            timeFormat: z.string(),
            timeStampFormat: z.string()
          })
          .passthrough()
      })
    ).parse(info.body);
    const dbs = await http.call('GET', '/databases');
    envelope(z.object({ databases: z.array(z.object({ name: z.string() })) })).parse(dbs.body);
    expect(dbs.body.response.databases.map((d: { name: string }) => d.name)).toEqual(
      expect.arrayContaining(['Sales', 'Quality', 'Inventory'])
    );
  });
  it('layout and script lists include nested folders', async () => {
    const layouts = await http.call('GET', '/databases/Quality/layouts', { token });
    envelope(z.object({ layouts: z.array(layoutNode) })).parse(layouts.body);
    const folder = layouts.body.response.layouts.find((l: { isFolder?: boolean }) => l.isFolder);
    expect(folder.folderLayoutNames.some((l: { isFolder?: boolean }) => l.isFolder)).toBe(true);
    const scripts = await http.call('GET', '/databases/Quality/scripts', { token });
    envelope(z.object({ scripts: z.array(scriptNode) })).parse(scripts.body);
  });
  it('layout metadata has fieldMetaData, portalMetaData and valueLists', async () => {
    const r = await http.call('GET', L('Customers'), { token });
    envelope(
      z.object({
        fieldMetaData: z.array(fieldMeta.passthrough()),
        portalMetaData: z.record(z.string(), z.array(fieldMeta.passthrough())),
        valueLists: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            values: z.array(z.object({ displayValue: z.string(), value: z.string() }))
          })
        )
      })
    ).parse(r.body);
    expect(Object.keys(r.body.response.portalMetaData)).toEqual(['Orders', 'CustomerNotes']);
  });
  it('a range of records, with portal paging, sorting and dateformats', async () => {
    const r = await http.call(
      'GET',
      `${L('Customers')}/records?_limit=5&_offset=2&_sort=${encodeURIComponent('[{"fieldName":"Balance","sortOrder":"descend"}]')}&portal=${encodeURIComponent('["Orders"]')}&_limit.Orders=2&dateformats=2`,
      { token }
    );
    expect(r.status).toBe(200);
    envelope(z.object({ data: z.array(record), dataInfo })).parse(r.body);
    expect(r.body.response.data).toHaveLength(5);
    const balances = r.body.response.data.map((d: { fieldData: { Balance: number } }) =>
      Number(d.fieldData.Balance)
    );
    expect(balances).toEqual([...balances].sort((a, b) => b - a));
    expect(Object.keys(r.body.response.data[0].portalData)).toEqual(['Orders']);
    for (const d of r.body.response.data) expect(d.portalData.Orders.length).toBeLessThanOrEqual(2);
    const joined = r.body.response.data.map(
      (d: { fieldData: { Joined: string } }) => d.fieldData.Joined
    );
    expect(joined.filter((v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)).length).toBeGreaterThan(0);
  });
  it('create, edit, duplicate, delete follow the documented bodies', async () => {
    const created = await http.call('POST', `${L('Products')}/records`, {
      token,
      body: { fieldData: { SKU: 'T-1', Name: 'Test', Category: 'Other', Price: 5 } }
    });
    envelope(z.object({ recordId: z.string(), modId: z.literal('0') })).parse(created.body);
    const id = created.body.response.recordId;
    const edited = await http.call('PATCH', `${L('Products')}/records/${id}`, {
      token,
      body: { fieldData: { Price: 6 }, modId: '0' }
    });
    envelope(z.object({ modId: z.literal('1') })).parse(edited.body);
    const dup = await http.call('POST', `${L('Products')}/records/${id}`, { token });
    envelope(z.object({ recordId: z.string(), modId: z.string() })).parse(dup.body);
    expect(dup.body.response.recordId).not.toBe(id);
    for (const rid of [id, dup.body.response.recordId])
      envelope(z.object({}).strict()).parse(
        (await http.call('DELETE', `${L('Products')}/records/${rid}`, { token })).body
      );
  });
  it('find returns data and dataInfo; 404 + 401 when nothing matches', async () => {
    const found = await http.call('POST', `${L('Customers')}/_find`, {
      token,
      body: { query: [{ Status: 'Open' }], limit: 3, offset: 2, portal: ['Orders'] }
    });
    envelope(z.object({ data: z.array(record).length(3), dataInfo })).parse(found.body);
    const none = await http.call('POST', `${L('Customers')}/_find`, {
      token,
      body: { query: [{ LastName: 'nonexistent-zzz' }] }
    });
    expect(none.status).toBe(404);
    expect(none.body.messages[0].code).toBe('401');
  });
  it('the HTTP status for "no records" is a switch: 404 by default, 500 on request', async () => {
    const find = () =>
      http.call('POST', `${L('Customers')}/_find`, {
        token,
        body: { query: [{ LastName: 'nonexistent-zzz' }] }
      });
    try {
      await admin('/__admin/config', { noRecordsStatus: 500 });
      const r = await find();
      expect(r.status).toBe(500);
      expect(r.body.messages[0].code).toBe('401');
    } finally {
      await admin('/__admin/config', { noRecordsStatus: 404 });
    }
    expect((await find()).status).toBe(404);
  });
  it('omit requests apply in order: [include, omit] differs from [omit, include]', async () => {
    const find = (query: unknown[]) =>
      http.call('POST', `${L('Customers')}/_find`, { token, body: { query, limit: 5 } });
    const inc = { Status: 'Open' };
    const omit = { Status: 'Open', omit: 'true' };
    const includeThenOmit = await find([inc, omit]);
    expect(includeThenOmit.status).toBe(404);
    const omitThenInclude = await find([omit, inc]);
    expect(omitThenInclude.status).toBe(200);
    expect(omitThenInclude.body.response.data.length).toBeGreaterThan(0);
  });
  it('container upload takes a multipart part named upload', async () => {
    const form = new FormData();
    form.append('upload', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
    const row = (await http.call('GET', `${L('Documents')}/records?_limit=1`, { token })).body
      .response.data[0];
    const r = await fetch(
      `${http.root}${L('Documents')}/records/${row.recordId}/containers/File/1`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
    );
    expect(r.status).toBe(200);
    const after = (await http.call('GET', `${L('Documents')}/records/${row.recordId}`, { token }))
      .body.response.data[0];
    expect(after.fieldData.File).toContain('/Streaming_SSL/MainDB/upload-');
    const url = new URL(after.fieldData.File, mock.baseUrl);
    const noCookie = await fetch(url);
    expect(noCookie.status).toBe(401);
    const withCookie = await fetch(url, { headers: { Cookie: `X-FM-Data-Access-Token=${token}` } });
    expect(await withCookie.text()).toBe('hello');
    const wrongType = await http.call(
      'POST',
      `${L('Documents')}/records/${row.recordId}/containers/File/1`,
      { token, body: {} }
    );
    expect(wrongType.status).toBe(415);
  });
  it('global fields are set per session', async () => {
    envelope(z.object({}).strict()).parse(
      (
        await http.call('PATCH', '/databases/Quality/globals', {
          token,
          body: { globalFields: { 'Customers::gFilter': 'abc' } }
        })
      ).body
    );
    const rec = (await http.call('GET', `${L('Customers')}/records?_limit=1`, { token })).body
      .response.data[0];
    expect(rec.fieldData.gFilter).toBe('abc');
    const other = (await http.login()).token;
    expect(
      (await http.call('GET', `${L('Customers')}/records?_limit=1`, { token: other })).body.response
        .data[0].fieldData.gFilter
    ).toBe('');
    expect(
      (
        await http.call('PATCH', '/databases/Quality/globals', {
          token,
          body: { globalFields: { 'Customers::Email': 'x' } }
        })
      ).body.messages[0].code
    ).toBe('102');
  });
  it('script endpoint and script parameters on record calls', async () => {
    const direct = await http.call(
      'GET',
      `${L('Customers')}/script/Echo?script.param=${encodeURIComponent('a b')}`,
      { token }
    );
    envelope(z.object({ scriptResult: z.literal('a b'), scriptError: z.literal('0') })).parse(
      direct.body
    );
    const withParams = await http.call(
      'GET',
      `${L('Customers')}/records?_limit=1&script=Echo&script.param=x&script.prerequest=Echo&script.prerequest.param=pre&script.presort=Echo&script.presort.param=sort`,
      { token }
    );
    expect(withParams.body.response).toMatchObject({
      scriptResult: 'x',
      scriptError: '0',
      'scriptResult.prerequest': 'pre',
      'scriptResult.presort': 'sort'
    });
    expect(
      (await http.call('GET', `${L('Customers')}/script/Fail`, { token })).body.response.scriptError
    ).toBe('3');
    expect(
      (await http.call('GET', `${L('Customers')}/script/Nope`, { token })).body.messages[0].code
    ).toBe('104');
    expect(
      (await http.call('POST', `${L('Customers')}/script/Echo`, { token, body: {} })).status
    ).toBe(405);
  });
  it('the script endpoint is GET only, takes script.param in the URL, and a script run reads no record', async () => {
    const log = async () => ((await (await fetch(`${mock.adminUrl}/__admin/log`)).json()) as { log: Array<{ method: string; path: string; query: string }> }).log;
    const before = (await log()).length;
    const name = 'Run / Ünï';
    const param = 'a b|c+d&e=f';
    const r = await http.call('GET', `${L('Customers')}/script/${encodeURIComponent(name)}?script.param=${encodeURIComponent(param)}`, { token });
    // Unknown script: FileMaker error 104 as the answer, still no record request.
    expect(r.body.messages[0].code).toBe('104');
    const echo = await http.call('GET', `${L('Customers')}/script/Echo?script.param=${encodeURIComponent(param)}`, { token });
    expect(echo.body.response.scriptResult).toBe(param);
    const noParam = await http.call('GET', `${L('Customers')}/script/Echo`, { token });
    expect(noParam.body.response.scriptError).toBe('0');
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      expect((await http.call(method, `${L('Customers')}/script/Echo`, { token, body: {} })).status, method).toBe(405);
    }
    const seen = (await log()).slice(before);
    expect(seen.some((entry) => /\/records|_find/.test(entry.path))).toBe(false);
    expect(seen.filter((entry) => entry.method === 'GET').every((entry) => /\/script\//.test(entry.path))).toBe(true);
  });
  it('a script can be attached to a find in the BODY (the documented form for a long parameter), limited to one record', async () => {
    const param = 'x'.repeat(5000);
    const r = await http.call('POST', `${L('Customers')}/_find`, { token, body: { query: [{}], limit: 1, script: 'Echo', 'script.param': param } });
    expect(r.body.response.data).toHaveLength(1);
    expect(r.body.response.scriptResult).toBe(param);
    expect(r.body.response.scriptError).toBe('0');
  });
  it('v1 and v2 URLs are accepted', async () => {
    for (const v of ['v1', 'v2']) {
      const h = api(mock.baseUrl, v);
      const t = (await h.login('Inventory')).token;
      expect(
        (await h.call('GET', '/databases/Inventory/layouts/Items/records?_limit=1', { token: t }))
          .status
      ).toBe(200);
    }
  });
});

describe('errors: HTTP status and messages[].code', () => {
  const expectError = (
    r: { status: number; body: { messages: Array<{ code: string }> } },
    status: number,
    code: string
  ) => {
    expect([r.status, r.body.messages[0]?.code]).toEqual([status, code]);
  };
  it('token errors (952) including database-name case and logout', async () => {
    expectError(await http.call('GET', L('Customers'), { token: 'bad' }), 401, '952');
    expectError(await http.call('GET', '/databases/quality/layouts', { token }), 401, '952');
    const t = (await http.login()).token;
    expect((await http.call('DELETE', `/databases/Quality/sessions/${t}`)).status).toBe(200);
    expectError(await http.call('GET', '/databases/Quality/layouts', { token: t }), 401, '952');
    expect((await http.call('GET', '/validateSession', { token })).status).toBe(200);
    expectError(await http.call('GET', '/validateSession', { token: t }), 401, '952');
  });
  it('login errors: 212 wrong password, inactive account, 802 unopenable database', async () => {
    expectError(await http.login('Quality', 'tester', 'wrong'), 401, '212');
    expectError(await http.login('Quality', 'retired', 'retired1'), 401, '212');
    expectError(await http.login('Locked'), 500, '802');
    expectError(await http.login('NoSuchDb'), 500, '802');
  });
  it('record, field, layout, script errors', async () => {
    expectError(await http.call('GET', `${L('Customers')}/records/1`, { token }), 500, '101');
    expectError(await http.call('GET', L('Nope'), { token }), 500, '105');
    expectError(
      await http.call('POST', `${L('Customers')}/_find`, {
        token,
        body: { query: [{ NoSuchField: 'x' }] }
      }),
      500,
      '102'
    );
    expectError(
      await http.call('POST', `${L('Customers')}/records`, {
        token,
        body: { fieldData: { NoSuchField: 'x' } }
      }),
      500,
      '102'
    );
    expectError(
      await http.call('POST', `${L('Customers')}/_find`, { token, body: { query: [] } }),
      500,
      '400'
    );
    expectError(
      await http.call('GET', `${L('Customers')}/records?_offset=0`, { token }),
      400,
      '960'
    );
    expectError(
      await http.call('GET', `${L('Customers')}/records?_offset=100000`, { token }),
      404,
      '401'
    );
  });
  it('modId mismatch 306 and validation errors', async () => {
    const row = (
      await http.call('POST', `${L('Products')}/records`, {
        token,
        body: { fieldData: { SKU: 'V-1' } }
      })
    ).body.response;
    await http.call('PATCH', `${L('Products')}/records/${row.recordId}`, {
      token,
      body: { fieldData: { Name: 'x' } }
    });
    expectError(
      await http.call('PATCH', `${L('Products')}/records/${row.recordId}`, {
        token,
        body: { fieldData: { Name: 'y' }, modId: '0' }
      }),
      500,
      '306'
    );
    expectError(
      await http.call('PATCH', `${L('Customers')}/records/3001`, {
        token,
        body: { fieldData: { Joined: '13/45/2026' } }
      }),
      500,
      '500'
    );
    expectError(
      await http.call('PATCH', `${L('Customers')}/records/3001`, {
        token,
        body: { fieldData: { Balance: 'abc' } }
      }),
      500,
      '502'
    );
    expectError(
      await http.call('POST', `${L('Products')}/records`, {
        token,
        body: { fieldData: { SKU: 'V-1' } }
      }),
      500,
      '504'
    );
    expectError(
      await http.call('POST', `${L('Products')}/records`, {
        token,
        body: { fieldData: { Category: 'Nope' } }
      }),
      500,
      '506'
    );
    expectError(
      await http.call('POST', `${L('Customers')}/records`, {
        token,
        body: { fieldData: { LastName: '  ' } }
      }),
      500,
      '509'
    );
    expectError(
      await http.call('PATCH', `${L('Customers')}/records/3001`, {
        token,
        body: { fieldData: { FullName: 'x' } }
      }),
      500,
      '201'
    );
    // entrymode "script" skips validation
    expect(
      (
        await http.call('PATCH', `${L('Customers')}/records/3001`, {
          token,
          body: { fieldData: { Joined: 'whenever' }, options: { entrymode: 'script' } }
        })
      ).status
    ).toBe(200);
    await admin('/__admin/reset', {});
    token = (await http.login()).token;
  });
  it('privileges: reader gets 9 on writes and scripts, nobody sees no layouts', async () => {
    const reader = (await http.login('Quality', 'reader', 'readpass1')).token;
    expect(
      (await http.call('GET', `${L('Customers')}/records?_limit=1`, { token: reader })).status
    ).toBe(200);
    expectError(
      await http.call('POST', `${L('Customers')}/records`, {
        token: reader,
        body: { fieldData: {} }
      }),
      403,
      '9'
    );
    expectError(
      await http.call('GET', `${L('Customers')}/script/Echo`, { token: reader }),
      403,
      '9'
    );
    const nobody = (await http.login('Quality', 'nobody', 'nopass1')).token;
    expect(
      (await http.call('GET', '/databases/Quality/layouts', { token: nobody })).body.response
        .layouts
    ).toEqual([]);
  });
  it('malformed requests: bad JSON 400, wrong content type 415, wrong method 405, OPTIONS 405', async () => {
    expectError(
      await http.call('POST', `${L('Customers')}/_find`, {
        token,
        raw: '{oops',
        headers: { 'Content-Type': 'application/json' }
      }),
      400,
      '960'
    );
    expectError(
      await http.call('POST', `${L('Customers')}/_find`, {
        token,
        raw: '{"query":[{}]}',
        headers: { 'Content-Type': 'text/plain' }
      }),
      415,
      '-1'
    );
    expectError(
      await http.call('PUT', `${L('Customers')}/records`, { token, body: {} }),
      405,
      '-1'
    );
    expect((await http.call('OPTIONS', `${L('Customers')}/records`, { token })).status).toBe(405);
  });
});

describe('session lifetime, limits and scenarios', () => {
  it('a token expires after the configured idle time and use refreshes it', async () => {
    await admin('/__admin/config', { ttlMs: 400 });
    try {
      const t = (await http.login()).token;
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        expect((await http.call('GET', '/validateSession', { token: t })).status).toBe(200);
      }
      await new Promise((r) => setTimeout(r, 600));
      expect((await http.call('GET', '/validateSession', { token: t })).status).toBe(401);
    } finally {
      await admin('/__admin/config', { ttlMs: 900000 });
    }
  });
  it('age and expire admin calls', async () => {
    const t = (await http.login()).token;
    await admin('/__admin/age', { ms: 1000000 });
    expect((await http.call('GET', '/validateSession', { token: t })).status).toBe(401);
    const t2 = (await http.login()).token;
    await admin('/__admin/expire', { token: t2 });
    expect((await http.call('GET', '/validateSession', { token: t2 })).status).toBe(401);
    token = (await http.login()).token;
  });
  it('the concurrent-session cap answers 503', async () => {
    const state = await admin('/__admin/state');
    await admin('/__admin/config', { maxSessions: state.sessions });
    try {
      const r = await http.login();
      expect([r.status, r.body.messages[0].code]).toEqual([503, '1633']);
    } finally {
      await admin('/__admin/config', { maxSessions: 500 });
    }
  });
  it('OAuth headers and Claris ID', async () => {
    const oauth = await http.call('POST', '/databases/Quality/sessions', {
      body: {},
      headers: {
        'X-FM-Data-OAuth-Request-Id': 'mock-oauth-request',
        'X-FM-Data-OAuth-Identifier': 'mock-oauth-identifier'
      }
    });
    expect(oauth.status).toBe(200);
    const bad = await http.call('POST', '/databases/Quality/sessions', {
      body: {},
      headers: { 'X-FM-Data-OAuth-Request-Id': 'x', 'X-FM-Data-OAuth-Identifier': 'y' }
    });
    expect(bad.status).toBe(401);
    expect(
      (
        await http.call('POST', '/databases/Quality/sessions', {
          body: {},
          headers: { Authorization: 'FMID mock-fmid-token' }
        })
      ).status
    ).toBe(401);
    await admin('/__admin/config', { cloud: true });
    try {
      expect(
        (
          await http.call('POST', '/databases/Quality/sessions', {
            body: {},
            headers: { Authorization: 'FMID mock-fmid-token' }
          })
        ).status
      ).toBe(200);
    } finally {
      await admin('/__admin/config', { cloud: false });
    }
    const url = await http.call(
      'GET',
      '/oauth/getoauthurl?provider=google&trackingID=1&address=127.0.0.1'
    );
    expect(url.headers.get('x-fms-request-id')).toBeTruthy();
  });
  it('a concurrent edit makes the next save conflict, and failNext injects one failure', async () => {
    const rec = (await http.call('GET', `${L('Products')}/records?_limit=1`, { token })).body
      .response.data[0];
    await admin('/__admin/concurrent-edit', {
      db: 'Quality',
      table: 'Products',
      recordId: rec.recordId,
      fieldData: { Name: 'edited elsewhere' }
    });
    const r = await http.call('PATCH', `${L('Products')}/records/${rec.recordId}`, {
      token,
      body: { fieldData: { Name: 'mine' }, modId: rec.modId }
    });
    expect(r.body.messages[0].code).toBe('306');
    await admin('/__admin/scenario', {
      failNext: [
        {
          match: { method: 'GET', path: '/records' },
          status: 500,
          code: 802,
          message: 'Unable to open file',
          count: 1
        }
      ]
    });
    expect(
      (await http.call('GET', `${L('Products')}/records?_limit=1`, { token })).body.messages[0].code
    ).toBe('802');
    expect((await http.call('GET', `${L('Products')}/records?_limit=1`, { token })).status).toBe(
      200
    );
    await admin('/__admin/scenario', { delayMs: 300 });
    const t0 = Date.now();
    await http.call('GET', '/productInfo');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    await admin('/__admin/scenario', { clear: true });
    await admin('/__admin/scenario', { rateLimit: { limit: 2, windowMs: 60000 } });
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await http.call('GET', '/productInfo')).status);
    expect(codes).toContain(429);
    await admin('/__admin/scenario', { clear: true });
    await admin('/__admin/reset', {});
    token = (await http.login()).token;
  });
});

describe('proxy mode', () => {
  it('serves the actions the extension proxy client sends', async () => {
    const post = async (
      action: string,
      payload: unknown = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<{ status: number; body: any }> => {
      const r = await fetch(mock.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mock-proxy-key' },
        body: JSON.stringify({
          action,
          profile: { id: 'p', database: 'Sales', serverUrl: 'x' },
          payload
        })
      });
      return { status: r.status, body: await r.json() };
    };
    expect((await post('createSession')).body.data.token).toBeTruthy();
    expect((await post('listLayouts')).body.data.layouts).toHaveLength(2);
    const found = await post('findRecords', {
      layout: 'Contacts',
      body: { query: [{ Status: 'Open' }], limit: 2 }
    });
    expect(found.body.data.result.data).toHaveLength(2);
    const edit = await post('editRecord', {
      layout: 'Contacts',
      recordId: '1001',
      fieldData: { Region: 'Proxy' }
    });
    expect(edit.body.data.result.modId).toBeTruthy();
    const bad = await post('getRecord', { layout: 'Contacts', recordId: '1' });
    expect(bad.body.ok).toBe(false);
    const noKey = await fetch(mock.proxyUrl, { method: 'POST', body: '{}' });
    expect(noKey.status).toBe(401);
  });
});
