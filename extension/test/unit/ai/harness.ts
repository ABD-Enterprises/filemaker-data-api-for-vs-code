import { vi } from 'vitest';

import type { AuditEntry } from '../../../src/ai/aiAudit';
import type { AiSettings } from '../../../src/ai/aiSettings';
import { AiToolService, type AiToolDeps, type ConfirmSpec } from '../../../src/ai/aiToolService';
import { FMClientError } from '../../../src/services/errors';
import type { ConnectionProfile, FileMakerRecord } from '../../../src/types/fm';

export const SECRET_HOST = 'secret-host.example.com';

export function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: 'Dev Server',
    database: 'Sales',
    authMode: 'direct',
    serverUrl: `https://${SECRET_HOST}:16000`,
    username: 'ai_reader',
    aiAccess: 'write',
    ...overrides
  };
}

export function makeSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    enabled: true,
    allowWrites: true,
    allowScripts: true,
    scriptAllowlist: { p1: ['Archive Old'] },
    readableLayouts: {},
    hiddenFields: [],
    connection: 'p1',
    ...overrides
  };
}

export function makeRecords(): Map<string, FileMakerRecord> {
  return new Map([
    [
      '1',
      {
        recordId: '1',
        modId: '3',
        fieldData: { Name: 'Ada', Email: 'ada@example.com', Salary: '90000', Photo: 'https://x/Streaming/1', Notes: 'see Bearer abc123def' },
        portalData: { Orders: [{ 'Orders::Total': '10', 'Orders::Salary': '5', recordId: '9', modId: '0' }] }
      }
    ],
    ['2', { recordId: '2', modId: '0', fieldData: { Name: 'Alan', Email: 'alan@example.com', Salary: '1', Photo: '', Notes: '' } }]
  ]);
}

export interface Harness {
  service: AiToolService;
  settings: AiSettings;
  profile: ConnectionProfile;
  records: Map<string, FileMakerRecord>;
  audit: AuditEntry[];
  confirms: ConfirmSpec[];
  state: { trusted: boolean; offline: boolean; featureSwitch: boolean; denyFeatures: Set<string>; denyReason?: string; now: number };
  confirm: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  notifyCancelled: ReturnType<typeof vi.fn>;
  client: Record<
    'listLayouts' | 'listScripts' | 'getRecord' | 'findRecords' | 'editRecord' | 'createRecord' | 'deleteRecord' | 'runScript',
    ReturnType<typeof vi.fn>
  >;
  schema: { getLayoutSchema: ReturnType<typeof vi.fn> };
  layoutFields: Array<{ name: string; result?: string }>;
  profiles: Map<string, ConnectionProfile>;
  getProfile: ReturnType<typeof vi.fn>;
}

/** A tool core wired to in-memory fakes. Every dependency is a vi.fn so tests can assert calls. */
export function makeHarness(options: { settings?: Partial<AiSettings>; profile?: Partial<ConnectionProfile> } = {}): Harness {
  const settings = makeSettings(options.settings);
  const profile = makeProfile(options.profile);
  const records = makeRecords();
  const audit: AuditEntry[] = [];
  const confirms: ConfirmSpec[] = [];
  const state: Harness['state'] = { trusted: true, offline: false, featureSwitch: true, denyFeatures: new Set<string>(), now: 1_000_000 };
  const layoutFields = [
    { name: 'Name', result: 'text' },
    { name: 'Email', result: 'text' },
    { name: 'Salary', result: 'number' },
    { name: 'Photo', result: 'container' },
    { name: 'Notes', result: 'text' },
    { name: 'Orders::Total', result: 'number' }
  ];

  const confirm = vi.fn(async (spec: ConfirmSpec) => {
    confirms.push(spec);
    return true;
  });
  const input = vi.fn<(spec: { title: string; prompt: string }) => Promise<string | undefined>>(async () => '1');

  const notifyCancelled = vi.fn();
  const client = {
    listLayouts: vi.fn(async () => ['Contacts', 'Orders', 'Odd/Layout']),
    listScripts: vi.fn(async () => ['Archive Old', 'Other Script', 'Bad`Script']),
    getRecord: vi.fn(async (_p: ConnectionProfile, _l: string, id: string) => {
      const record = records.get(id);
      if (!record) throw new FMClientError('Record is missing', { code: '101', status: 500 });
      return structuredClone(record);
    }),
    findRecords: vi.fn(async () => ({
      data: [...records.values()].map((record) => structuredClone(record)),
      dataInfo: { foundCount: records.size }
    })),
    editRecord: vi.fn(async (_p: ConnectionProfile, _l: string, id: string, data: Record<string, unknown>, _c: unknown, opts?: { modId?: string }) => {
      const record = records.get(id);
      if (!record) throw new FMClientError('Record is missing', { code: '101' });
      if (opts?.modId !== undefined && opts.modId !== record.modId) {
        throw new FMClientError('Record modification ID does not match', { code: '306', status: 500 });
      }
      Object.assign(record.fieldData, data);
      record.modId = String(Number(record.modId) + 1);
      return { recordId: id, modId: record.modId, messages: [], response: {} };
    }),
    createRecord: vi.fn(async () => ({ recordId: '99', modId: '0', messages: [], response: {} })),
    deleteRecord: vi.fn(async (_p: ConnectionProfile, _l: string, id: string) => {
      records.delete(id);
      return { recordId: id, messages: [], response: {} };
    }),
    runScript: vi.fn(async () => ({ messages: [], response: { scriptResult: 'done', scriptError: '0' } }))
  };
  const schema = {
    getLayoutSchema: vi.fn(async () => ({ supported: true, fromCache: false, fields: layoutFields }))
  };

  const profiles = new Map<string, ConnectionProfile>([[profile.id, profile]]);
  const getProfile = vi.fn(async (id: string) => profiles.get(id));

  const deps: AiToolDeps = {
    settings: () => settings,
    featureSwitchOn: () => state.featureSwitch,
    featureGuard: (feature) =>
      state.denyFeatures.has(feature) ? { allowed: false, reason: state.denyReason ?? `${feature} is disabled by policy.` } : { allowed: true },
    isTrusted: () => state.trusted,
    isOffline: () => state.offline,
    getProfile,
    client: client as never,
    schema: schema as never,
    ui: { confirm, input, notifyCancelled },
    audit: { record: async (entry) => void audit.push(entry) },
    now: () => state.now
  };

  return { service: new AiToolService(deps), profiles, getProfile, notifyCancelled, settings, profile, records, audit, confirms, state, confirm, input, client, schema, layoutFields };
}

/** Runs a call that should fail and returns its message. */
export async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the call to fail');
}
