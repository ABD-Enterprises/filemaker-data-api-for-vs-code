import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { FMClientError } from '../../src/services/errors';
import { SecretStore } from '../../src/services/secretStore';
import { BatchService } from '../../src/services/batchService';
import { JobRunner } from '../../src/services/jobRunner';
import { executeSavedQueryAgainstClient } from '../../src/services/savedQueryRunner';
import { buildRequestSpec } from '../../src/snippets';
import { parseFindJson } from '../../src/utils/jsonValidate';
import { getFileMakerErrorInfo } from '../../src/utils/fileMakerCodes';
import type { ConnectionProfile, SavedQuery } from '../../src/types/fm';
import { createAxiosResponse, InMemoryMemento, InMemorySecretStorage } from './mocks';

const profile: ConnectionProfile = { id: 'regression', name: 'Test', authMode: 'direct', serverUrl: 'https://fm.example.com', database: 'Sales', username: 'tester' };
const advice = 'Enter at least one field value to search, or use Get records to list records';
const ok = (response: Record<string, unknown>) => createAxiosResponse({ data: { response, messages: [{ code: '0', message: 'OK' }] } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(options?: { now: () => number }) {
  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  await secrets.setPassword(profile.id, 'testpass1');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const http = { request: vi.fn() };
  const client = new FMClient(secrets, logger, 15000, http as never, undefined, undefined, undefined,
    options ? { maxAgeMs: 60000, refreshLeadMs: 10000, ...options } : undefined);
  return { secrets, logger, http, client };
}

describe('session cancellation and retirement regressions', () => {
  it.each(['initial', 'proactive', 'rejected'] as const)('cancels only one waiter during %s sign-in', async (mode) => {
    let now = 0;
    const h = await setup({ now: () => now });
    const login = deferred<ReturnType<typeof ok>>();
    const started = deferred<void>();
    h.http.request.mockImplementation(async (config) => {
      if (config.method === 'POST') {
        started.resolve();
        config.signal?.addEventListener('abort', () => login.reject(new FMClientError('Request cancelled.', { kind: 'cancellation' })), { once: true });
        return login.promise;
      }
      if (mode === 'rejected' && config.headers.Authorization === 'Bearer old') {
        throw { isAxiosError: true, response: { status: 401, data: { response: {}, messages: [{ code: '952', message: 'Invalid token' }] } } };
      }
      return ok({ data: [{ recordId: '1', fieldData: {} }] });
    });
    if (mode !== 'initial') {
      await h.secrets.setSessionToken(profile.id, 'old');
      if (mode === 'proactive') {
        h.http.request.mockResolvedValueOnce(ok({ token: 'old' }));
        await h.client.createSession(profile);
        now = 51000;
      }
    }
    const controller = new AbortController();
    let firstSettled = false;
    const first = h.client.getRecord(profile, 'Contacts', '1', { signal: controller.signal }).catch((error: unknown) => error).finally(() => { firstSettled = true; });
    const second = h.client.getRecord(profile, 'Contacts', '2');
    const secondOutcome = second.catch((error: unknown) => error);
    await started.promise;
    controller.abort();
    await vi.waitFor(() => expect(firstSettled).toBe(true));
    login.resolve(ok({ token: 'new' }));
    expect(await first).toMatchObject({ kind: 'cancellation' });
    expect(await secondOutcome).toMatchObject({ recordId: '1' });
    expect(h.http.request.mock.calls.filter(([config]) => config.method === 'POST')).toHaveLength(mode === 'proactive' ? 2 : 1);
  });

  it.each(['proactive', 'rejected'] as const)('returns the new token while %s retirement is still pending, including a late old-token rejection', async (mode) => {
    let now = 0;
    const h = await setup({ now: () => now });
    const deletion = deferred<ReturnType<typeof ok>>();
    const late = deferred<ReturnType<typeof ok>>();
    h.http.request.mockResolvedValueOnce(ok({ token: 'old' }));
    await h.client.createSession(profile);
    let oldRequests = 0;
    h.http.request.mockImplementation(async (config) => {
      if (config.method === 'POST') return ok({ token: 'new' });
      if (config.method === 'DELETE') return deletion.promise;
      if (config.headers.Authorization === 'Bearer old') {
        oldRequests += 1;
        if (oldRequests === 1) return late.promise;
        throw { isAxiosError: true, response: { status: 401 } };
      }
      return ok({ data: [{ recordId: '1', fieldData: {} }] });
    });
    vi.spyOn(h.client, 'shouldRefreshSession').mockReturnValue(false);
    const old = h.client.getRecord(profile, 'Contacts', '1');
    await vi.waitFor(() => expect(oldRequests).toBe(1));
    if (mode === 'proactive') vi.mocked(h.client.shouldRefreshSession).mockReturnValue(true);
    now = 1000;
    let finished = false;
    const fresh = h.client.getRecord(profile, 'Contacts', '2').finally(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 300 });
      await fresh;
      vi.mocked(h.client.shouldRefreshSession).mockReturnValue(false);
      late.reject({ isAxiosError: true, response: { status: 401 } });
      expect(await old).toMatchObject({ recordId: '1' });
      expect(h.http.request.mock.calls.filter(([config]) => config.method === 'POST')).toHaveLength(2);
      expect(await h.secrets.getSessionToken(profile.id)).toBe('new');
    } finally {
      deletion.resolve(ok({}));
      late.reject({ isAxiosError: true, response: { status: 401 } });
      await Promise.allSettled([old, fresh]);
    }
  });

  it.each([false, true])('retires the old token after renewal even if cleanup fails=%s', async (fails) => {
    let now = 0;
    const h = await setup({ now: () => now });
    let serial = 0;
    h.http.request.mockImplementation(async (config) => {
      if (config.method === 'POST') return ok({ token: `token-${++serial}` });
      if (config.method === 'DELETE' && fails) throw new Error('cleanup failed token-1');
      return ok({ data: [{ recordId: '1', fieldData: {} }] });
    });
    await h.client.getRecord(profile, 'Contacts', '1');
    for (let cycle = 0; cycle < 4; cycle += 1) {
      now += 51000;
      await h.client.getRecord(profile, 'Contacts', '1');
      expect(h.http.request.mock.calls.at(-1)?.[0].headers.Authorization).toBe(`Bearer token-${cycle + 2}`);
    }
    const deletes = h.http.request.mock.calls.filter(([config]) => config.method === 'DELETE');
    expect(deletes.map(([config]) => config.url)).toEqual([1, 2, 3, 4].map((i) => `${profile.serverUrl}/fmi/data/vLatest/databases/Sales/sessions/token-${i}`));
    for (const [config] of deletes) expect(config.timeout).toBeLessThanOrEqual(3000);
    expect(await h.secrets.getSessionToken(profile.id)).toBe('token-5');
    expect(JSON.stringify(h.logger)).not.toContain('token-1');
    expect(h.logger.warn.mock.calls.flat().join(' ')).not.toContain('token-1');
  });

  it.each([true, false])('cleans up a rejected token only while presumed live=%s', async (live) => {
    let now = 0;
    const h = await setup({ now: () => now });
    h.http.request.mockResolvedValueOnce(ok({ token: 'old' }));
    await h.client.createSession(profile);
    now = live ? 1000 : 1000000;
    // Avoid the proactive path: this test exercises rejection-driven replacement.
    vi.spyOn(h.client, 'shouldRefreshSession').mockReturnValue(false);
    h.http.request.mockImplementation(async (config) => {
      if (config.method === 'POST') return ok({ token: 'new' });
      if (config.method === 'GET' && config.headers.Authorization === 'Bearer old') throw { isAxiosError: true, response: { status: 401 } };
      return ok({ data: [{ recordId: '1', fieldData: {} }] });
    });
    await h.client.getRecord(profile, 'Contacts', '1');
    expect(h.http.request.mock.calls.filter(([config]) => config.method === 'DELETE')).toHaveLength(live ? 1 : 0);
  });
});

describe('cancelled batch audit', () => {
  it('waits for edits to settle, keeps their ids and codes in Jobs, and starts no queued edit', async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const editRecord = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const batch = new BatchService({ editRecord } as never, { getConcurrency: () => 2, getDryRunDefault: () => false });
    const runner = new JobRunner(new InMemoryMemento() as never);
    const entries = ['1', '2', '3', '4'].map((recordId) => ({ recordId, fieldData: { Name: 'changed' } }));
    const handle = runner.startJob('Batch update', (job) => batch.batchUpdate(profile, 'Contacts', entries, {}, job));
    await vi.waitFor(() => expect(editRecord).toHaveBeenCalledTimes(2));
    handle.cancel();
    expect(handle.getState().status).toBe('cancelling');
    expect(handle.getState().finishedAt).toBeUndefined();
    a.resolve();
    await vi.waitFor(() => expect(handle.getState().progress).toBe(25));
    expect(handle.getState().status).toBe('cancelling');
    b.reject(new FMClientError('Record in use', { code: '301', isRetryable: true }));
    await vi.waitFor(() => expect(handle.getState().status).toBe('cancelled'));
    expect(editRecord).toHaveBeenCalledTimes(2);
    expect(handle.getState()).toMatchObject({ details: 'Cancelled after 2 of 4', result: { attempted: 2, successCount: 1, updatedIds: ['1'], failures: [{ recordId: '2', code: '301' }], notAttemptedIds: ['3', '4'], notAttempted: 2 } });
    expect(runner.getRecentSummaries()[0]).toMatchObject({ result: handle.getState().result, details: 'Cancelled after 2 of 4' });
  });
  it('does not dequeue records after cancellation while scheduling', async () => {
    let cancelled = false;
    const editRecord = vi.fn(async () => { cancelled = true; });
    const batch = new BatchService({ editRecord } as never, { getConcurrency: () => 2, getDryRunDefault: () => false });
    const result = await batch.batchUpdate(profile, 'Contacts', ['1', '2', '3'].map((recordId) => ({ recordId, fieldData: { Name: 'changed' } })), {}, {
      isCancellationRequested: () => cancelled, reportProgress() {}, log() {}
    });
    expect(editRecord).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempted: 1, updatedIds: ['1'], failures: [], notAttemptedIds: ['2', '3'] });
  });

  it('does not start a retry after cancellation during backoff', async () => {
    vi.useFakeTimers();
    try {
      const failed = new FMClientError('Record in use', { code: '301', isRetryable: true });
      const editRecord = vi.fn().mockRejectedValueOnce(failed).mockResolvedValue(undefined);
      let cancelled = false;
      const batch = new BatchService({ editRecord } as never, { getConcurrency: () => 1, getDryRunDefault: () => false });
      const pending = batch.batchUpdate(profile, 'Contacts', [{ recordId: '1', fieldData: { Name: 'changed' } }], {}, {
        isCancellationRequested: () => cancelled, reportProgress() {}, log() {}
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(editRecord).toHaveBeenCalledTimes(1);
      cancelled = true;
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ attempted: 1, successCount: 0, failures: [{ recordId: '1', code: '301' }] });
      expect(editRecord).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

});

describe('empty find prevention', () => {
  it('saved-query execution refuses an empty saved find before calling a client', async () => {
    const findRecords = vi.fn(async () => ({ data: [] }));
    await expect(executeSavedQueryAgainstClient({ findJson: [{}], layout: 'Contacts' } as SavedQuery, profile, { findRecords } as never)).rejects.toThrow(advice);
    expect(findRecords).not.toHaveBeenCalled();
  });

  it.each([[], [{}], [{ omit: 'true' }], [{ Name: '' }]].map((query) => ({ query })))('refuses $query in the client, saved runs, parsing and copied code', async ({ query }) => {
    const h = await setup();
    h.http.request.mockResolvedValue(ok({ token: 'unused', data: [] }));
    await expect(h.client.findRecords(profile, 'Contacts', { query })).rejects.toMatchObject({ code: '400', message: expect.stringContaining(advice) });
    expect(h.http.request).not.toHaveBeenCalled();
    await expect(executeSavedQueryAgainstClient({ findJson: query, layout: 'Contacts' } as SavedQuery, profile, h.client)).rejects.toThrow(advice);
    expect(parseFindJson(JSON.stringify(query))).toMatchObject({ ok: false, error: expect.stringContaining(advice) });
    for (const target of [profile, { ...profile, authMode: 'proxy' as const, proxyEndpoint: 'https://proxy.example' }]) {
      expect(() => buildRequestSpec(target, { kind: 'find', layout: 'Contacts', request: { query } })).toThrow(advice);
    }
  });

  it.each(['10', '400'])('gives plain next steps for FileMaker code %s', (code) => {
    expect(getFileMakerErrorInfo(code)?.advice).toContain(advice);
  });

  it.each([{ query: [] }, { query: [{}] }, { query: [{ omit: 'true' }] }, {}])('mock engine follows the verified empty/missing contract for %j', async (body) => {
    const module = await import(path.resolve(__dirname, '../mock-server/lib/engine.mjs'));
    const engine = module.createEngine();
    const dispatch = (route: string, payload: unknown, headers: Record<string, string>) => engine.dispatch({ method: 'POST', pathname: `/fmi/data/vLatest/databases/Sales/${route}`, query: new URLSearchParams(), headers: { host: 'localhost', 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(payload)) });
    const session = await dispatch('sessions', {}, { authorization: `Basic ${Buffer.from('tester:testpass1').toString('base64')}` });
    const response = await dispatch('layouts/Contacts/_find', body, { authorization: `Bearer ${session.json.response.token}`, 'content-type': 'application/json' });
    const missing = !('query' in body);
    expect(response).toMatchObject({ status: missing ? 400 : 500, json: { messages: [{ code: missing ? '10' : '400', message: missing ? 'Missing required property: query' : 'Find criteria are empty' }] } });
  });
});

describe('read and script GET carriers', () => {
  it('lists records with the exact layout and pagination, with no empty find', async () => {
    const h = await setup();
    h.http.request.mockResolvedValueOnce(ok({ token: 'session' })).mockResolvedValueOnce(ok({ data: [{ recordId: '4', fieldData: {} }], dataInfo: { returnedCount: 1 } }));
    expect(await h.client.listRecords(profile, ' Contacts ', { limit: 1, offset: 3, sort: [{ fieldName: ' Name ', sortOrder: 'ascend' }] })).toMatchObject({ data: [{ recordId: '4' }] });
    expect(h.http.request.mock.calls.at(-1)?.[0]).toMatchObject({ method: 'GET', url: `${profile.serverUrl}/fmi/data/vLatest/databases/Sales/layouts/%20Contacts%20/records`, params: { _limit: 1, _offset: 3, _sort: '[{"fieldName":" Name ","sortOrder":"ascend"}]' } });
  });

  it('uses GET records when the script endpoint is unavailable', async () => {
    const h = await setup();
    h.http.request.mockResolvedValueOnce(ok({ token: 'session' }))
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 405 } })
      .mockResolvedValueOnce(ok({ data: [{ recordId: '1', fieldData: { Private: 'hidden' } }], scriptError: '0', scriptResult: 'done' }));
    expect(await h.client.runScript(profile, { layout: ' Contacts ', scriptName: ' Echo ', scriptParam: 'x y' })).toMatchObject({ response: { scriptResult: 'done' } });
    expect(h.http.request.mock.calls.at(-1)?.[0]).toMatchObject({ method: 'GET', params: { _limit: 1, script: ' Echo ', 'script.param': 'x y' } });
  });

  it('refuses long script parameters without a text field, also in copied requests', async () => {
    const h = await setup();
    h.http.request.mockResolvedValue(ok({ token: 'unused', scriptError: '0', data: [{ recordId: '1', fieldData: {} }] }));
    const request = { layout: 'Contacts', scriptName: 'Echo', scriptParam: 'x'.repeat(4000) };
    await expect(h.client.runScript(profile, request)).rejects.toMatchObject({ code: 'SCRIPT_PARAMETER_TOO_LONG' });
    expect(h.http.request.mock.calls.map(([config]) => config.method)).toEqual(['POST', 'GET', 'GET']);
    expect(h.http.request.mock.calls.at(-1)?.[0]).toMatchObject({ url: expect.stringContaining('/layouts/Contacts/records'), params: { _limit: 1 } });
    expect(() => buildRequestSpec(profile, { kind: 'runScript', ...request })).toThrow(/too long/);
  });
});


describe('long script parameters through the mock engine without sockets', () => {
  it.each(['200', '404', '500'])('executes a wildcard body script, then refuses an empty layout with HTTP %s / code 401', async (status) => {
    const module = await import(path.resolve(__dirname, '../mock-server/lib/engine.mjs'));
    const engine = module.createEngine({ env: { NO_RECORDS_STATUS: status } });
    engine.state.config.noRecordsStatus = Number(status);
    const h = await setup();
    h.http.request.mockImplementation(async (config) => {
      const url = new URL(config.url);
      const reply = await engine.dispatch({ method: config.method, pathname: url.pathname, query: new URLSearchParams(config.params),
        headers: { host: 'localhost', 'content-type': 'application/json', authorization: config.headers.Authorization },
        body: Buffer.from(JSON.stringify(config.data ?? {})) });
      return { ...createAxiosResponse({ data: reply.json }), status: reply.status };
    });
    const request = { layout: 'Contacts', scriptName: 'Echo', scriptParam: 'x'.repeat(3000) };
    expect(await h.client.runScript(profile, request)).toMatchObject({ response: { scriptResult: request.scriptParam, scriptError: '0' } });
    const customers = engine.state.dbs.Quality.tables.Customers;
    const count = customers.rows.length;
    const session = await engine.dispatch({ method: 'POST', pathname: '/fmi/data/vLatest/databases/Quality/sessions',
      headers: { host: 'localhost', 'content-type': 'application/json', authorization: `Basic ${Buffer.from('tester:testpass1').toString('base64')}` }, body: Buffer.from('{}') });
    const none = await engine.dispatch({ method: 'POST', pathname: '/fmi/data/vLatest/databases/Quality/layouts/Customers/_find',
      headers: { host: 'localhost', 'content-type': 'application/json', authorization: `Bearer ${session.json.response.token}` },
      body: Buffer.from(JSON.stringify({ query: [{ LastName: '==NEVER_MATCH_THIS_SCRIPT_FIND' }], limit: 1, script: 'Create Customer', 'script.prerequest': 'Create Customer', 'script.presort': 'Create Customer' })) });
    expect(none).toMatchObject({ status: Number(status), json: { messages: [{ code: '401' }] } });
    expect(Object.keys(none.json.response).some((key) => key.startsWith('script'))).toBe(false);
    expect(customers.rows).toHaveLength(count);
    engine.state.dbs.Sales.tables.Contacts.rows.length = 0;
    await expect(h.client.runScript(profile, request)).rejects.toMatchObject({ code: '401',
      message: 'The script did not run because this layout has no records. Add a record or use a layout that has records.' });
    expect(h.http.request.mock.calls.filter(([config]) => config.url.includes('/script/'))).toHaveLength(0);
  });
});
