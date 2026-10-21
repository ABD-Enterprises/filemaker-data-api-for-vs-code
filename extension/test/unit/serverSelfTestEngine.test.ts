import path from 'path';

import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { createSelfTestClient } from '../../src/services/serverSelfTestClient';
import { renderSelfTestReport, testMyServer, type SelfTestUi } from '../../src/services/serverSelfTest';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from './mocks';

interface Engine {
  dispatch(input: { method: string; pathname: string; query: URLSearchParams; headers: Record<string, string>; body: Buffer }): Promise<{ status: number; headers: Record<string, string>; json: { response?: { recordId?: string } } }>;
}

// The same engine as the socket server, with HTTP intercepted in memory. This lets
// the sandbox exercise its actual sessions, find rules and modification IDs too.
describe('Test My Server through the real client and repository mock engine (no sockets)', () => {
  it.each(['404', '500'])('records no-records HTTP %s and verifies writes and logout', async (status) => {
    const modulePath = path.resolve(__dirname, '../mock-server/lib/engine.mjs');
    const module = await import(modulePath) as { createEngine(options: { env: Record<string, string> }): Engine };
    const engine = module.createEngine({ env: { NO_RECORDS_STATUS: status } });
    const profile: ConnectionProfile = { id: 'self', name: 'Self', authMode: 'direct', serverUrl: 'http://127.0.0.1:18080', username: 'tester', database: 'Sales' };
    let createdId: string | undefined;
    const server = nock(profile.serverUrl).persist();
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) server.intercept(/.*/, method).reply(async function (uri, body) {
      const url = new URL(uri, profile.serverUrl);
      const headers = Object.fromEntries(Object.entries(this.req.headers).map(([key, value]) => [key, String(value)]));
      const reply = await engine.dispatch({ method: this.req.method, pathname: url.pathname, query: url.searchParams, headers, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {})) });
      if (this.req.method === 'POST' && url.pathname.endsWith('/records')) createdId = reply.json.response?.recordId;
      return [reply.status, reply.json, reply.headers];
    });
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword(profile.id, 'testpass1');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const client = await createSelfTestClient(profile, secrets, logger, 3000);
    const ui: SelfTestUi = {
      start: async () => 'write', pickLayout: async () => 'Contacts', pickField: async (fields) => fields[0],
      confirmWrite: async () => true, script: async () => undefined, confirmScript: async () => false,
      allowed: () => true, progress: () => {}
    };
    try {
      const report = (await testMyServer(client, profile, ui, new AbortController().signal))!;
      expect(report.facts).toContain(`No records: HTTP ${status}, FileMaker 401.`);
      expect(report.steps.find((row) => row.step === 'Stale-modId error check')).toMatchObject({ result: 'PASS', code: '306' });
      expect(report.steps.find((row) => row.step === 'Delete scratch record (cleanup)')?.result).toBe('PASS');
      expect(report.steps.find((row) => row.step === 'Old session after logout')?.result).toBe('PASS');
      expect(report.problems).toEqual([]);
      expect(renderSelfTestReport(report)).not.toContain('testpass1');
      expect(createdId).toBeDefined();
      await client.createSession(profile);
      await expect(client.getRecord(profile, 'Contacts', createdId!)).rejects.toMatchObject({ code: '101' });
      await client.deleteSession(profile);
    } finally { server.persist(false); }
  });
});
