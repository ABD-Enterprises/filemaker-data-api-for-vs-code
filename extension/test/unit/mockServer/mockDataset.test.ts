import { execFileSync } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, type RunningMock, startMockProcess } from './mockHelper';

const mockDir = path.resolve(__dirname, '../../mock-server');
let mock: RunningMock;
let http: ReturnType<typeof api>;
let token: string;
let manifest: {
  totals: Record<string, number>;
  hostileLayoutNames: string[];
  hostileFieldNames: string[];
  databases: Record<
    string,
    { tables: Record<string, { recordCount: number; conditions: Record<string, string[]> }> }
  >;
};

const L = (name: string) => `/databases/Quality/layouts/${encodeURIComponent(name)}`;
const ids = (table: string, cond: string) =>
  manifest.databases.Quality!.tables[table]!.conditions[cond]!.filter((x) => !x.startsWith('gap:'));
const get = async (layout: string, id: string) =>
  (await http.call('GET', `${L(layout)}/records/${id}`, { token })).body.response.data[0];

beforeAll(async () => {
  mock = await startMockProcess();
  http = api(mock.baseUrl);
  token = (await http.login()).token;
  manifest = (await (await fetch(`${mock.adminUrl}/__admin/manifest`)).json()) as typeof manifest;
}, 30000);
afterAll(async () => mock?.stop());

describe('mock dataset', () => {
  it('the committed manifest files match the generator', () => {
    execFileSync(process.execPath, [path.join(mockDir, 'lib/manifest.mjs'), '--check'], {
      stdio: 'pipe'
    });
  });
  it('has the required volume and a clean majority in the main layout', () => {
    expect(manifest.databases.Quality!.tables.Customers!.recordCount).toBeGreaterThanOrEqual(100);
    expect(Object.values(manifest.totals).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(500);
    const customers = manifest.databases.Quality!.tables.Customers!;
    expect(customers.conditions.clean!.length / customers.recordCount).toBeLessThan(0.5);
    expect(customers.conditions.clean!.length).toBeGreaterThan(60);
  });
  it('is deterministic: two servers return the same first page', async () => {
    const other = await startMockProcess();
    try {
      const a = JSON.stringify(
        (
          await http.call(
            'GET',
            `${L('Customers')}/records?_limit=100&_sort=${encodeURIComponent('[{"fieldName":"CustomerID"}]')}`,
            { token }
          )
        ).body.response.data
      );
      const h2 = api(other.baseUrl);
      const t2 = (await h2.login()).token;
      const b = JSON.stringify(
        (
          await h2.call(
            'GET',
            `${L('Customers')}/records?_limit=100&_sort=${encodeURIComponent('[{"fieldName":"CustomerID"}]')}`,
            { token: t2 }
          )
        ).body.response.data
      );
      expect(a).toBe(b);
    } finally {
      await other.stop();
    }
  });
  it('record ids are non-contiguous', async () => {
    const all = (
      await http.call('GET', `${L('Customers')}/records?_limit=500`, { token })
    ).body.response.data
      .map((r: { recordId: string }) => Number(r.recordId))
      .sort((a: number, b: number) => a - b);
    expect(all.some((v: number, i: number) => i > 0 && v - all[i - 1] > 1)).toBe(true);
    const gap = manifest.databases.Quality!.tables.Customers!.conditions[
      'non-contiguous-ids'
    ]![0]!.replace('gap:', '');
    expect(
      (await http.call('GET', `${L('Customers')}/records/${gap}`, { token })).body.messages[0].code
    ).toBe('101');
  });
  it('manifest conditions point at records that really have the property', async () => {
    const note = async (cond: string) =>
      Promise.all(ids('Customers', cond).map((id) => get('Customers', id)));
    for (const r of await note('csv-formula'))
      expect(/^[=+\-@\t\r'＝ \n]/.test(r.fieldData.Notes)).toBe(true);
    for (const r of await note('empty-strings')) expect(r.fieldData.Email).toBe('');
    for (const r of await note('whitespace-only')) expect(r.fieldData.Company.trim()).toBe('');
    expect((await note('long-text-12k'))[0].fieldData.Notes.length).toBeGreaterThan(10000);
    expect((await note('long-text-300k'))[0].fieldData.Bio.length).toBeGreaterThan(299000);
    for (const r of await note('missing-fields')) expect(r.fieldData).not.toHaveProperty('Phone');
    for (const r of await note('portal-0')) expect(r.portalData.Orders).toEqual([]);
    expect((await note('portal-1'))[0].portalData.Orders).toHaveLength(1);
    const many = (await note('portal-many'))[0];
    expect(many.portalData.Orders).toHaveLength(50);
    const page = await http.call(
      'GET',
      `${L('Customers')}/records/${many.recordId}?portal=${encodeURIComponent('["Orders"]')}&_limit.Orders=200&_offset.Orders=1`,
      { token }
    );
    expect(page.body.response.data[0].portalData.Orders).toHaveLength(170 + 0);
    expect(page.body.response.dataInfo.portalDataInfo[0].foundCount).toBe(170);
    const blank = (await note('portal-empty-rows'))[0];
    expect(
      blank.portalData.Orders.some((o: Record<string, string>) => o['Orders::Status'] === '')
    ).toBe(true);
    for (const r of await note('prompt-injection'))
      expect(r.fieldData.Notes.length).toBeGreaterThan(0);
    const hostToken = (await note('host-like')).map((r) => r.fieldData.InternalUrl);
    expect(hostToken).toContain(token); // {{TOKEN}} is the caller's own session token
    expect(hostToken.some((v: string) => v.startsWith(mock.baseUrl))).toBe(true); // {{BASE}}
    const containers = await note('container-normal');
    expect(containers[0].fieldData.Avatar).toContain('/Streaming_SSL/');
    const bio = (await note('unicode')).map((r) => r.fieldData.Company).join('');
    expect(bio).toContain('山田太郎');
    expect(bio).toContain('‮');
  });
  it('repeating fields come back as Name(n)', async () => {
    const r = await get('Customers', ids('Customers', 'repetitions')[0]!);
    expect(Object.keys(r.fieldData).filter((k) => k.startsWith('Phones('))).toEqual([
      'Phones(1)',
      'Phones(2)',
      'Phones(3)'
    ]);
  });
  it('huge container streams about 25 MB', async () => {
    const res = await fetch(new URL('/Streaming_SSL/MainDB/huge-avatar.bin', mock.baseUrl), {
      headers: { Cookie: `X-FM-Data-Access-Token=${token}` }
    });
    expect(Number(res.headers.get('content-length'))).toBe(25 * 1024 * 1024);
    await res.body?.cancel();
    const traversal = await fetch(
      new URL('/Streaming_SSL/MainDB/..%2F..%2Fetc%2Fpasswd', mock.baseUrl),
      { headers: { Cookie: `X-FM-Data-Access-Token=${token}` } }
    );
    expect(traversal.status).toBe(404);
  });
  it('hostile layout names resolve only as literal names (never a path)', async () => {
    const list = (
      await http.call('GET', '/databases/Quality/layouts', { token })
    ).body.response.layouts.map((l: { name: string }) => l.name);
    for (const name of manifest.hostileLayoutNames) {
      expect(list).toContain(name);
      const r = await http.call('GET', `${L(name)}/records?_limit=1`, { token });
      expect(r.status, name).toBe(200);
      expect(r.body.response.data[0].fieldData.Name).toMatch(/^probe-/);
    }
    expect(
      (await http.call('GET', `${L('../Customers')}/records`, { token })).body.messages[0].code
    ).toBe('105');
  });
  it('hostile field names survive a round trip, including __proto__, RecordID and modId', async () => {
    const rec = (await http.call('GET', `${L('Hostile')}/records?_limit=60`, { token })).body
      .response.data;
    expect(rec).toHaveLength(60);
    const keys = Object.keys(rec[0].fieldData);
    for (const name of manifest.hostileFieldNames) expect(keys, name).toContain(name);
    expect(Object.getPrototypeOf(rec[0].fieldData)).toBe(Object.prototype);
    const id = rec[0].recordId;
    const edit = await http.call('PATCH', `${L('Hostile')}/records/${id}`, {
      token,
      body: { fieldData: { __proto__x: 1 } }
    });
    expect(edit.body.messages[0].code).toBe('102');
    const ok = await http.call('PATCH', `${L('Hostile')}/records/${id}`, {
      token,
      raw: '{"fieldData":{"__proto__":"set","RecordID":"r","modId":"m"}}',
      headers: { 'Content-Type': 'application/json' }
    });
    expect(ok.status).toBe(200);
    const after = await get('Hostile', id);
    expect(Object.hasOwn(after.fieldData, '__proto__')).toBe(true);
    expect(after.fieldData.RecordID).toBe('r');
    expect(after.recordId).toBe(id);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('find over 100+ rows pages and sorts consistently', async () => {
    const total = (
      await http.call('POST', `${L('Customers')}/_find`, {
        token,
        body: { query: [{ CustomerID: '*' }], limit: 1 }
      })
    ).body.response.dataInfo.foundCount;
    expect(total).toBeGreaterThanOrEqual(100);
    const seen = new Set<string>();
    for (let offset = 1; offset <= total; offset += 40) {
      const page = await http.call('POST', `${L('Customers')}/_find`, {
        token,
        body: {
          query: [{ CustomerID: '*' }],
          sort: [{ fieldName: 'CustomerID', sortOrder: 'ascend' }],
          limit: 40,
          offset
        }
      });
      for (const r of page.body.response.data) seen.add(r.recordId);
    }
    expect(seen.size).toBe(total);
  });
});

describe('TLS modes', () => {
  const get = (url: string, options: https.RequestOptions) =>
    new Promise<number>((resolve, reject) => {
      https
        .get(url, options, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
  it('self-signed: rejected by default, accepted when verification is off', async () => {
    const tls = await startMockProcess({ TLS: 'self-signed' });
    try {
      expect(tls.baseUrl.startsWith('https://')).toBe(true);
      await expect(get(`${tls.baseUrl}/fmi/data/vLatest/productInfo`, {})).rejects.toThrow(
        /self[- ]signed|unable to verify/i
      );
      expect(
        await get(`${tls.baseUrl}/fmi/data/vLatest/productInfo`, { rejectUnauthorized: false })
      ).toBe(200);
    } finally {
      await tls.stop();
    }
  });
  it('ca: accepted when the CA file is trusted', async () => {
    const tls = await startMockProcess({ TLS: 'ca' });
    try {
      expect(tls.caPath).toBeTruthy();
      await expect(get(`${tls.baseUrl}/fmi/data/vLatest/productInfo`, {})).rejects.toThrow();
      expect(
        await get(`${tls.baseUrl}/fmi/data/vLatest/productInfo`, {
          ca: readFileSync(tls.caPath!, 'utf8')
        })
      ).toBe(200);
    } finally {
      await tls.stop();
    }
  });
  it('a separate admin port keeps /__admin off the main port', async () => {
    const m = await startMockProcess({ ADMIN_PORT: '0' });
    try {
      expect(m.adminUrl).not.toBe(m.baseUrl);
      expect((await fetch(`${m.baseUrl}/__admin/state`)).status).toBe(404);
      expect((await fetch(`${m.adminUrl}/__admin/state`)).status).toBe(200);
    } finally {
      await m.stop();
    }
  });
});
