import { readFileSync } from 'node:fs';
import https from 'node:https';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, type RunningMock, startMockProcess } from './mockHelper';

// The named faults, accounts and TLS modes that the failure-mode UI journeys (e2e-ui/journeys/j13*) rely on.
let mock: RunningMock;
let http: ReturnType<typeof api>;

beforeAll(async () => {
  mock = await startMockProcess();
  http = api(mock.baseUrl);
}, 30000);
afterAll(async () => mock?.stop());

const admin = async (route: string, body?: unknown) =>
  (
    await fetch(mock.adminUrl + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  ).json() as Promise<Record<string, unknown>>;

describe('login faults', () => {
  it.each([
    ['login-inactive', 401, '210'],
    ['login-expired-password', 401, '211'],
    ['login-locked', 401, '214'],
    ['login-no-fmrest', 500, '802'],
    ['login-session-limit', 500, '956'],
    ['db-not-hosted', 500, '100']
  ])('%s answers %i / %s once and then recovers', async (name, status, code) => {
    await admin('/__admin/fault', { name, count: 1 });
    const bad = await http.login();
    expect([bad.status, bad.body.messages[0].code]).toEqual([status, code]);
    expect((await http.login()).status).toBe(200);
  });
  it('a changed password is refused with 212 until restored', async () => {
    await admin('/__admin/account', { name: 'tester', password: 'changed' });
    expect((await http.login()).body.messages[0].code).toBe('212');
    await admin('/__admin/reset-accounts', {});
    expect((await http.login()).status).toBe(200);
  });
});

describe('gateway faults', () => {
  it('html-200, empty-200, truncated-json and array-body are not Data API envelopes', async () => {
    for (const name of ['html-200', 'empty-200', 'truncated-json', 'array-body']) {
      await admin('/__admin/fault', { name, count: 1 });
      const res = await fetch(`${mock.baseUrl}/fmi/data/vLatest/databases/Quality/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      expect(res.status, name).toBe(200);
      const text = await res.text();
      expect(() => (JSON.parse(text) as { response?: unknown }).response, name).toSatisfy(() => {
        try {
          const v = JSON.parse(text) as unknown;
          return !(v && typeof v === 'object' && !Array.isArray(v) && 'response' in v);
        } catch {
          return true;
        }
      });
    }
  });
  it('status faults carry HTML, and 429 carries Retry-After', async () => {
    await admin('/__admin/fault', { name: 'status-429', count: 1, retryAfter: 3 });
    const res = await fetch(`${mock.baseUrl}/fmi/data/vLatest/productInfo`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.text()).toContain('<html');
  });
  it('redirects do not mint a session on their own', async () => {
    await admin('/__admin/fault', {
      name: 'redirect-other-origin',
      count: 1,
      target: 'http://127.0.0.1:9'
    });
    const res = await fetch(`${mock.baseUrl}/fmi/data/vLatest/productInfo`, { redirect: 'manual' });
    expect([res.status, res.headers.get('location')]).toEqual([
      307,
      'http://127.0.0.1:9/fmi/data/vLatest/productInfo'
    ]);
  });
  it('data-api-disabled answers an HTML 404 on every Data API path', async () => {
    await admin('/__admin/fault', { name: 'data-api-disabled' });
    const res = await fetch(`${mock.baseUrl}/fmi/data/vLatest/productInfo`);
    expect([res.status, res.headers.get('content-type')]).toEqual([404, 'text/html']);
    await admin('/__admin/fault', { clear: true });
    expect((await fetch(`${mock.baseUrl}/fmi/data/vLatest/productInfo`)).status).toBe(200);
  });
  it('messages-nonzero-200 keeps HTTP 200 but reports a FileMaker error', async () => {
    await admin('/__admin/fault', { name: 'messages-nonzero-200', count: 1, code: 212 });
    const r = await http.login();
    expect([r.status, r.body.messages[0].code]).toEqual([200, '212']);
  });
  it('drop-mid-response closes the connection after the headers', async () => {
    await admin('/__admin/fault', { name: 'drop-mid-response', count: 1 });
    await expect(
      fetch(`${mock.baseUrl}/fmi/data/vLatest/productInfo`).then((r) => r.text())
    ).rejects.toThrow();
  });
});

describe('accounts and record faults', () => {
  it('viewer is refused per method with 200, 205 and 9; Email is hidden', async () => {
    const { token } = await http.login('Sales', 'viewer', 'viewpass1');
    const L = '/databases/Sales/layouts/Contacts';
    const rec = await http.call('GET', `${L}/records/1001`, { token });
    expect(rec.body.response.data[0].fieldData).not.toHaveProperty('Email');
    expect(
      (
        await http.call('PATCH', `${L}/records/1001`, {
          token,
          body: { fieldData: { Region: 'x' } }
        })
      ).body.messages[0].code
    ).toBe('200');
    expect(
      (await http.call('POST', `${L}/records`, { token, body: { fieldData: {} } })).body.messages[0]
        .code
    ).toBe('205');
    const del = await http.call('DELETE', `${L}/records/1001`, { token });
    expect([del.status, del.body.messages[0].code]).toEqual([403, '9']);
  });
  it('limited sees only Contacts', async () => {
    const { token } = await http.login('Sales', 'limited', 'limitpass1');
    const layouts = await http.call('GET', '/databases/Sales/layouts', { token });
    expect(layouts.body.response.layouts).toEqual([{ name: 'Contacts' }]);
    expect(
      (await http.call('GET', '/databases/Sales/layouts/Invoices/records', { token })).body
        .messages[0].code
    ).toBe('105');
  });
  it('record-locked, record-gone, validation-fail, field-readonly and script-error-after-edit', async () => {
    const { token } = await http.login('Quality');
    const L = '/databases/Quality/layouts/Products';
    const id = (
      (await http.call('GET', `${L}/records?_limit=1`, { token })).body.response.data[0] as {
        recordId: string;
      }
    ).recordId;
    for (const [name, code] of [
      ['record-locked', '301'],
      ['record-gone', '101'],
      ['validation-fail', '509']
    ] as const) {
      await admin('/__admin/fault', { name, count: 1 });
      expect(
        (
          await http.call('PATCH', `${L}/records/${id}`, {
            token,
            body: { fieldData: { Name: 'x' } }
          })
        ).body.messages[0].code,
        name
      ).toBe(code);
    }
    await admin('/__admin/fault', { name: 'field-readonly', field: 'Name', count: 1 });
    expect(
      (
        await http.call('PATCH', `${L}/records/${id}`, {
          token,
          body: { fieldData: { Name: 'x' } }
        })
      ).body.messages[0].code
    ).toBe('201');
    await admin('/__admin/fault', { name: 'script-error-after-edit', count: 1 });
    const saved = await http.call('PATCH', `${L}/records/${id}`, {
      token,
      body: { fieldData: { Name: 'y' } }
    });
    expect(saved.body.response.scriptError).toBe('3');
  });
  it('find-no-match-500 answers 500 with code 401; many creates a Big layout', async () => {
    const { token } = await http.login('Quality');
    await admin('/__admin/fault', { name: 'find-no-match-500', count: 1 });
    const r = await http.call('POST', '/databases/Quality/layouts/Customers/_find', {
      token,
      body: { query: [{ LastName: 'zzzz-none' }] }
    });
    expect([r.status, r.body.messages[0].code]).toEqual([500, '401']);
    await admin('/__admin/many', { db: 'Quality', n: 150 });
    const big = await http.call('GET', '/databases/Quality/layouts/Big/records?_limit=1', {
      token
    });
    expect(big.body.response.dataInfo.totalRecordCount).toBe(150);
  });
});

describe('TLS modes produce the Node errors the catalogue lists', () => {
  const get = (url: string, options: https.RequestOptions) =>
    new Promise<string>((resolve) => {
      https
        .get(url, options, (res) => {
          res.resume();
          resolve(`OK ${res.statusCode}`);
        })
        .on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
    });
  it.each([
    ['claris-default-cert', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ['expired', 'CERT_HAS_EXPIRED'],
    ['notyet', 'CERT_NOT_YET_VALID'],
    ['wronghost', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ['missing-intermediate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['tls10-only', 'EPROTO']
  ])('%s with the CA trusted gives %s', async (mode, code) => {
    const m = await startMockProcess({ TLS: mode });
    try {
      expect(
        await get(`${m.baseUrl}/fmi/data/vLatest/productInfo`, {
          ca: readFileSync(m.caPath!, 'utf8')
        })
      ).toBe(code);
    } finally {
      await m.stop();
    }
  });
});
