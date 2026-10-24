import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSelfTestClient } from '../../../src/services/serverSelfTestClient';
import { renderSelfTestReport, testMyServer, type SelfTestUi } from '../../../src/services/serverSelfTest';
import { SecretStore } from '../../../src/services/secretStore';
import type { ConnectionProfile } from '../../../src/types/fm';
import { InMemorySecretStorage } from '../mocks';
import { startMockProcess, type RunningMock } from './mockHelper';

// Needs loopback sockets. The orchestrator runs this outside the restricted sandbox.
describe('Test My Server against the repository mock server', () => {
  let mock: RunningMock | undefined;
  afterEach(async () => { await mock?.stop(); mock = undefined; });
  it.each(['404', '500'])('observes NO_RECORDS_STATUS=%s, conflict 306, cleanup and logout using the real client', async (status) => {
    mock = await startMockProcess({ NO_RECORDS_STATUS: status });
    const profile: ConnectionProfile = { id: 'self', name: 'Self', authMode: 'direct', serverUrl: mock.baseUrl, username: 'tester', database: 'Sales' };
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword(profile.id, 'testpass1');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const client = await createSelfTestClient(profile, secrets, logger, 3000);
    const ui: SelfTestUi = {
      start: async () => 'write', pickLayout: async () => 'Contacts', pickField: async (fields) => fields[0],
      confirmWrite: async () => true, script: async () => undefined, confirmScript: async () => false,
      allowed: () => true, progress: () => {}
    };
    const report = (await testMyServer(client, profile, ui, new AbortController().signal))!;
    expect(report.facts).toContain(`No records: HTTP ${status}, FileMaker 401.`);
    expect(report.steps.find((row) => row.step === 'Stale-modId error check')).toMatchObject({ result: 'PASS', code: '306' });
    expect(report.steps.find((row) => row.step === 'Delete scratch record (cleanup)')?.result).toBe('PASS');
    expect(report.steps.find((row) => row.step === 'Old session after logout')?.result).toBe('PASS');
    expect(report.problems).toEqual([]);
    expect(renderSelfTestReport(report)).not.toContain('testpass1');
    expect(await secrets.getSessionToken(profile.id)).toBeUndefined();
  }, 30000);
});
