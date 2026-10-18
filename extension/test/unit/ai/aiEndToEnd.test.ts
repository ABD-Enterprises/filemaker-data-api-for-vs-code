import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiToolService, type ConfirmSpec } from '../../../src/ai/aiToolService';
import { FMClient } from '../../../src/services/fmClient';
import { SchemaService } from '../../../src/services/schemaService';
import { SecretStore } from '../../../src/services/secretStore';
import type { ConnectionProfile } from '../../../src/types/fm';
import { InMemorySecretStorage } from '../mocks';
import { makeSettings } from './harness';

// The real FMClient and SchemaService against the mock Data API (test/mock-server/server.mjs)
// over real HTTP: the tool core's reads and confirmed writes, end to end.
let child: ChildProcess;
let base = '';
let profile: ConnectionProfile;
let service: AiToolService;
const confirms: ConfirmSpec[] = [];
const typed = vi.fn(async (): Promise<string | undefined> => undefined);
let answer = true;
let onConfirm: (() => Promise<void>) | undefined;
const clock = { value: 1_000_000 };
const nextMinute = (): number => (clock.value += 61_000);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  nock.enableNetConnect('127.0.0.1');
  const port = await freePort();
  child = spawn(process.execPath, [path.resolve(__dirname, '../../mock-server/server.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${base}/__admin/reset`, { method: 'POST' });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  await secrets.setPassword('p1', 'testpass1');
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const client = new FMClient(secrets, logger as never, 5000);
  const schema = new SchemaService(client, logger as never);
  profile = {
    id: 'p1',
    name: 'Mock',
    authMode: 'direct',
    serverUrl: base,
    database: 'Sales',
    username: 'tester',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest',
    aiAccess: 'write'
  };
  const settings = makeSettings({ scriptAllowlist: { p1: ['Echo'] }, hiddenFields: ['Amount'] });
  service = new AiToolService({
    settings: () => settings,
    featureSwitchOn: () => true,
    featureGuard: () => ({ allowed: true }),
    isTrusted: () => true,
    isOffline: () => false,
    getProfile: async () => profile,
    client,
    schema,
    ui: {
      confirm: async (spec) => {
        confirms.push(spec);
        await onConfirm?.();
        return answer;
      },
      input: typed
    },
    audit: { record: async () => undefined },
    now: () => clock.value
  });
}, 20_000);

afterAll(() => {
  child?.kill();
  nock.disableNetConnect();
});

describe('AI tools against the mock Data API', () => {
  it('reads layouts, describes one (hidden field removed) and finds records', async () => {
    const layouts = (await service.invoke('fm_list_layouts', {})) as { layouts: Array<{ name: string }> };
    expect(layouts.layouts.map((layout) => layout.name)).toEqual(['Contacts', 'Invoices']);

    const described = (await service.invoke('fm_describe_layout', { layout: 'Contacts' })) as { fields: Array<{ name: string }> };
    expect(described.fields.map((field) => field.name)).toContain('Email');
    expect(described.fields.map((field) => field.name)).not.toContain('Amount');

    const found = (await service.invoke('fm_find_records', {
      layout: 'Contacts',
      requests: [{ fields: { Status: '==Closed' } }],
      sort: [{ field: 'Email', order: 'desc' }],
      limit: 3
    })) as { records: Array<{ fields: Record<string, unknown> }>; foundCount: number };
    expect(found.records).toHaveLength(3);
    expect(found.foundCount).toBeGreaterThan(40);
    expect(found.records.every((record) => !('Amount' in record.fields))).toBe(true);
    expect(JSON.stringify(found)).not.toContain(base);

    const rejected = await service.invoke('fm_find_records', { layout: 'Contacts', requests: [{ fields: { Amount: '>1' } }] }).catch((e: Error) => e.message);
    expect(rejected).toMatch(/Unknown or unavailable field/);
  });

  it('answers an empty find with no records instead of an error', async () => {
    const result = (await service.invoke('fm_find_records', { layout: 'Contacts', requests: [{ fields: { Email: '==nobody@nowhere.test' } }] })) as { records: unknown[] };
    expect(result.records).toEqual([]);
  });

  it('edits a record only after the host modal, using the real modId, and refuses a stale one with 306', async () => {
    const before = (await service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1001' })) as { records: Array<{ modId: string; fields: Record<string, string> }> };
    const modId = before.records[0]!.modId;

    answer = true;
    const result = (await service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1001', fields: { Region: 'Moon' } })) as { written: boolean; modId: string };
    expect(result.written).toBe(true);
    expect(Number(result.modId)).toBe(Number(modId) + 1);
    expect(confirms.at(-1)?.detail).toContain('"Region":');
    expect(confirms.at(-1)?.detail).toContain('-> "Moon"');

    const after = (await service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1001' })) as { records: Array<{ fields: Record<string, string> }> };
    expect(after.records[0]!.fields.Region).toBe('Moon');

    // Someone else changes the record while the dialog is open: the modId sent is the one read
    // before the dialog, so FileMaker refuses it (error 306) and nothing is overwritten.
    nextMinute();
    const login = await fetch(`${base}/fmi/data/vLatest/databases/Sales/sessions`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from('tester:testpass1').toString('base64')}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
    const token = ((await login.json()) as { response: { token: string } }).response.token;
    onConfirm = async () => {
      await fetch(`${base}/fmi/data/vLatest/databases/Sales/layouts/Contacts/records/1002`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldData: { Region: 'Someone Else' } })
      });
    };
    try {
      await expect(service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1002', fields: { Region: 'Mars' } })).rejects.toThrow(
        /changed by someone else/
      );
    } finally {
      onConfirm = undefined;
    }
    const check = (await service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1002' })) as { records: Array<{ fields: Record<string, string> }> };
    expect(check.records[0]!.fields.Region).toBe('Someone Else');
  });

  it('runs an allowlisted script after confirmation and refuses one that is not', async () => {
    nextMinute();
    answer = true;
    const ran = (await service.invoke('fm_run_script', { layout: 'Contacts', script: 'Echo', parameter: 'hi' })) as { ran: boolean };
    expect(ran.ran).toBe(true);
    await expect(service.invoke('fm_run_script', { layout: 'Contacts', script: 'Rebuild Index' })).rejects.toThrow(/allowlist/);
  });

  it('creates and deletes a record only with confirmation and the typed id', async () => {
    nextMinute();
    answer = true;
    const created = (await service.invoke('fm_create_record', { layout: 'Invoices', fields: { Invoice: 'INV-E2E' } })) as { recordId: string };
    expect(created.recordId).toBeTruthy();

    typed.mockResolvedValueOnce(undefined);
    expect(await service.invoke('fm_delete_record', { layout: 'Invoices', recordId: created.recordId })).toMatchObject({ deleted: false });
    typed.mockResolvedValueOnce(created.recordId);
    expect(await service.invoke('fm_delete_record', { layout: 'Invoices', recordId: created.recordId })).toMatchObject({ deleted: true });
  });
});
