import { describe, expect, it, vi } from 'vitest';

import { FMClientError } from '../../src/services/errors';
import { renderSelfTestReport, testMyServer, type SelfTestClient, type SelfTestObservation, type SelfTestUi } from '../../src/services/serverSelfTest';
import type { ConnectionProfile } from '../../src/types/fm';

const profile: ConnectionProfile = { id: 'p', name: 'Test', serverUrl: 'https://private.example', database: 'Test', authMode: 'direct' };
const layout = ' Contacts ';
const field = ' Name ';

function harness() {
  const controller = new AbortController();
  let observed: SelfTestObservation = {};
  const success = <T>(value: T) => { observed = { status: 200, code: '0', message: 'OK', tls: 'TLSv1.3' }; return value; };
  const client = {
    getProductInfo: vi.fn(async () => success({ version: '21.1' })),
    createSession: vi.fn(async () => success('private-token')),
    listHostedDatabases: vi.fn(async () => success(['Test'])),
    listLayouts: vi.fn(async () => success([layout, 'Second', 'Third', 'Fourth'])),
    listScripts: vi.fn(async () => success(['DO NOT PRINT THIS SCRIPT'])),
    getLayoutMetadata: vi.fn<SelfTestClient['getLayoutMetadata']>(async () => success({ fieldMetaData: [{ name: field, result: 'text', type: 'normal' }, { name: 'Calc', result: 'text', type: 'calculation' }] })),
    listRecords: vi.fn(async () => success({ data: [{ recordId: '7', modId: '1', fieldData: { [field]: 'PRIVATE RECORD VALUE' } }] })),
    findRecords: vi.fn(async (_profile, _layout, body) => {
      if (Object.keys(body.query[0] ?? {}).length) {
        observed = { status: 500, code: '401', message: 'No records match the request' };
        return { data: [] };
      }
      return success({ data: [{ recordId: '7', modId: '1', fieldData: { [field]: 'PRIVATE RECORD VALUE' } }] });
    }),
    getRecord: vi.fn(async () => success({ recordId: '8', modId: '1', fieldData: {} })),
    createRecord: vi.fn(async () => success({ recordId: '8', modId: '1', messages: [], response: {} })),
    editRecord: vi.fn(async (_profile, _layout, _id, _fields, _control, options) => {
      if (client.editRecord.mock.calls.length > 1 && options?.modId === '1') {
        observed = { status: 500, code: '306', message: 'Record modification ID does not match' };
        throw new FMClientError('conflict', { status: 500, code: '306' });
      }
      return success({ recordId: '8', modId: '2', messages: [], response: {} });
    }),
    deleteRecord: vi.fn(async () => success({ recordId: '8', messages: [], response: {} })),
    runScript: vi.fn<SelfTestClient['runScript']>(async () => success({ response: { scriptResult: 'PRIVATE SCRIPT RESULT' }, messages: [] })),
    deleteSession: vi.fn(async () => { success(undefined); }),
    verifyLoggedOut: vi.fn<SelfTestClient['verifyLoggedOut']>(async () => {
      observed = { status: 401, code: '952', message: 'Invalid FileMaker Data API token' };
      throw new FMClientError('invalid', { status: 401, code: '952' });
    }),
    resetObservation: () => { observed = {}; },
    observation: () => ({ ...observed }),
    scrub: (text: string) => text.replaceAll('private-token', '***')
  } satisfies SelfTestClient;
  const ui = {
    start: vi.fn<SelfTestUi['start']>(async () => 'read'),
    pickLayout: vi.fn<SelfTestUi['pickLayout']>(async () => layout),
    pickField: vi.fn<SelfTestUi['pickField']>(async () => field),
    confirmWrite: vi.fn(async () => true),
    script: vi.fn<SelfTestUi['script']>(async () => undefined),
    confirmScript: vi.fn(async () => true),
    allowed: vi.fn<SelfTestUi['allowed']>(() => true),
    progress: vi.fn()
  } satisfies SelfTestUi;
  const run = () => testMyServer(client, profile, ui, controller.signal);
  return { client, ui, run, controller, setObservation: (value: SelfTestObservation) => { observed = value; } };
}

describe('Test My Server', () => {
  it('runs read-only by default, counts only, limits metadata to three and preserves exact names', async () => {
    const { run, client, ui } = harness();
    const report = (await run())!;
    expect(client.getLayoutMetadata.mock.calls.map((call) => call[1])).toEqual([layout, 'Second', 'Third']);
    expect(client.listRecords).toHaveBeenCalledWith(profile, layout, { limit: 1 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(client.findRecords.mock.calls[0]?.[2].query[0]).toHaveProperty(field);
    expect(client.getRecord).toHaveBeenCalledWith(profile, layout, '7', expect.anything());
    expect(client.createRecord).not.toHaveBeenCalled();
    expect(ui.confirmWrite).not.toHaveBeenCalled();
    expect(client.runScript).not.toHaveBeenCalled();
    expect(report.facts).toContain('No records: HTTP 500, FileMaker 401.');
    expect(report.facts).toContain('Script count: 1.');
    expect(report.facts).toContain('TLS protocol: TLSv1.3');
    expect(report.facts.join(' ')).toContain('old token refused');
    const text = renderSelfTestReport(report);
    expect(text).toContain('| PASS |');
    expect(text).not.toMatch(/PRIVATE RECORD VALUE|DO NOT PRINT THIS SCRIPT|private-token/);
    expect(client.deleteSession).toHaveBeenCalledOnce();
  });

  it.each([404, 500])('captures exact no-records HTTP %i even when find returns an empty result', async (status) => {
    const h = harness();
    h.client.findRecords.mockImplementation(async () => {
      h.setObservation({ status, code: '401', message: 'No records match' });
      return { data: [] };
    });
    const report = (await h.run())!;
    expect(report.facts).toContain(`No records: HTTP ${status}, FileMaker 401.`);
    expect(report.steps.find((row) => row.step === 'No-records error check')).toMatchObject({ result: 'PASS', status, code: '401' });
  });

  it('records a no-records finding from the first find even without a second probe', async () => {
    const h = harness();
    h.client.listRecords.mockImplementation(async () => {
      h.setObservation({ status: 404, code: '401', message: 'No records match' });
      return { data: [] };
    });
    h.ui.pickField.mockResolvedValue(undefined);
    const report = (await h.run())!;
    expect(report.facts).toContain('No records: HTTP 404, FileMaker 401.');
    expect(h.client.getRecord).not.toHaveBeenCalled();
  });

  it('skips a filtered database list but keeps a real server failure as FAIL', async () => {
    const h = harness();
    h.client.listHostedDatabases.mockResolvedValue(undefined as never);
    const skipped = (await h.run())!;
    expect(skipped.steps.find((row) => row.step === 'List databases')?.result).toBe('WARN');
    h.client.listHostedDatabases.mockRejectedValue(new FMClientError('server failed', { status: 500 }));
    const failed = (await h.run())!;
    expect(failed.steps.find((row) => row.step === 'List databases')?.result).toBe('FAIL');
  });

  it('makes no requests when the first modal is dismissed', async () => {
    const h = harness(); h.ui.start.mockResolvedValue(undefined);
    expect(await h.run()).toBeUndefined();
    expect(h.client.getProductInfo).not.toHaveBeenCalled();
    expect(h.client.createSession).not.toHaveBeenCalled();
    expect(h.client.createRecord).not.toHaveBeenCalled();
  });

  it.each(['read', 'second declined', 'no scratch', 'no field', 'policy'])('never writes without both confirmations and a scratch choice: %s', async (reason) => {
    const h = harness();
    if (reason !== 'read') h.ui.start.mockResolvedValue('write');
    if (reason === 'second declined') h.ui.confirmWrite.mockResolvedValue(false);
    if (reason === 'no scratch') h.ui.pickLayout.mockImplementation(async (_layouts, scratch) => scratch ? undefined : layout);
    if (reason === 'no field') h.ui.pickField.mockImplementation(async (_fields, scratch) => scratch ? undefined : field);
    if (reason === 'policy') h.ui.allowed.mockImplementation((kind) => kind !== 'write');
    await h.run();
    expect(h.client.createRecord).not.toHaveBeenCalled();
    expect(h.client.editRecord).not.toHaveBeenCalled();
    expect(h.client.deleteRecord).not.toHaveBeenCalled();
  });

  it('creates, gets, edits with the current modId, tests stale modId, and cleans up', async () => {
    const h = harness(); h.ui.start.mockResolvedValue('write');
    const report = (await h.run())!;
    expect(h.ui.confirmWrite).toHaveBeenCalledWith(layout);
    expect(h.client.createRecord).toHaveBeenCalledWith(profile, layout, { [field]: 'FileMaker server test' }, expect.anything());
    expect(h.client.editRecord.mock.calls.map((call) => call[5])).toEqual([{ modId: '1' }, { modId: '1' }]);
    expect(h.client.deleteRecord).toHaveBeenCalledWith(profile, layout, '8');
    expect(report.steps.find((row) => row.step === 'Stale-modId error check')).toMatchObject({ result: 'PASS', status: 500, code: '306' });
    expect(report.problems).toEqual([]);
  });

  it.each(['get', 'edit', 'cancel'])('always cleans up after a middle step %s', async (failure) => {
    const h = harness(); h.ui.start.mockResolvedValue('write');
    if (failure === 'get') h.client.getRecord.mockRejectedValue(new FMClientError('failed'));
    if (failure === 'edit') h.client.editRecord.mockRejectedValue(new FMClientError('failed'));
    if (failure === 'cancel') h.client.createRecord.mockImplementation(async () => {
      h.controller.abort();
      return { recordId: '8', modId: '1', messages: [], response: {} };
    });
    await h.run();
    expect(h.client.deleteRecord).toHaveBeenCalledWith(profile, layout, '8');
    expect(h.client.deleteSession).toHaveBeenCalledOnce();
    if (failure === 'cancel') {
      expect(h.client.editRecord).not.toHaveBeenCalled();
      expect(h.client.verifyLoggedOut).not.toHaveBeenCalled();
    }
  });

  it('warns about an uncertain create when no record ID was received', async () => {
    const h = harness(); h.ui.start.mockResolvedValue('write');
    h.client.createRecord.mockRejectedValue(new Error('connection lost'));
    const report = (await h.run())!;
    expect(report.problems.join(' ')).toContain('a test record may remain');
    expect(h.client.deleteRecord).not.toHaveBeenCalled();
    expect(h.client.deleteSession).toHaveBeenCalledOnce();
  });

  it('reports the record ID and next step when cleanup fails', async () => {
    const h = harness(); h.ui.start.mockResolvedValue('write');
    h.client.deleteRecord.mockRejectedValue(new Error('failure'));
    const report = (await h.run())!;
    expect(report.problems.join(' ')).toContain(`Remove test record ID 8 from layout ${layout}`);
    expect(h.client.deleteSession).toHaveBeenCalledOnce();
  });

  it('cancels in-flight work and starts no further tests; still logs out', async () => {
    const h = harness();
    h.client.listLayouts.mockImplementation(async () => { h.controller.abort(); throw new Error('canceled'); });
    const report = (await h.run())!;
    expect(h.client.listScripts).not.toHaveBeenCalled();
    expect(h.client.getLayoutMetadata).not.toHaveBeenCalled();
    expect(h.client.verifyLoggedOut).not.toHaveBeenCalled();
    expect(h.client.deleteSession).toHaveBeenCalledOnce();
    expect(renderSelfTestReport(report)).toContain('Stopped by cancellation');
  });

  it('stops immediately when cancellation arrives with a successful response', async () => {
    const h = harness();
    h.client.listLayouts.mockImplementation(async () => { h.controller.abort(); return [layout]; });
    await h.run();
    expect(h.client.listScripts).not.toHaveBeenCalled();
    expect(h.client.getLayoutMetadata).not.toHaveBeenCalled();
    expect(h.client.deleteSession).toHaveBeenCalledOnce();
  });

  it('stops before any request when already canceled or offline', async () => {
    for (const offline of [false, true]) {
      const h = harness();
      if (offline) h.ui.allowed.mockReturnValue(false); else h.controller.abort();
      await h.run();
      expect(h.client.getProductInfo).not.toHaveBeenCalled();
      expect(h.client.createSession).not.toHaveBeenCalled();
    }
  });

  it('checks policy again after the write confirmation', async () => {
    const h = harness(); h.ui.start.mockResolvedValue('write');
    h.ui.confirmWrite.mockImplementation(async () => { h.ui.allowed.mockImplementation((kind) => kind !== 'write'); return true; });
    await h.run();
    expect(h.client.createRecord).not.toHaveBeenCalled();
  });

  it('skips the error probe when no text field is selected', async () => {
    const h = harness(); h.ui.pickField.mockResolvedValue(undefined);
    await h.run();
    expect(h.client.listRecords).toHaveBeenCalledOnce();
    expect(h.client.findRecords).not.toHaveBeenCalled();
  });

  it('requires typed script and confirmation; preserves script and parameter exactly', async () => {
    const h = harness();
    h.ui.script.mockResolvedValue({ name: ' Script ', parameter: ' parameter ' });
    h.ui.confirmScript.mockResolvedValue(false);
    await h.run();
    expect(h.client.runScript).not.toHaveBeenCalled();
    h.ui.confirmScript.mockResolvedValue(true);
    const report = (await h.run())!;
    expect(h.client.runScript).toHaveBeenCalledWith(profile, { layout, scriptName: ' Script ', scriptParam: ' parameter ' }, expect.anything());
    expect(renderSelfTestReport(report)).not.toMatch(/PRIVATE SCRIPT RESULT| parameter /);
  });

  it('reports script errors even when HTTP succeeded', async () => {
    const h = harness(); h.ui.script.mockResolvedValue({ name: 'x', parameter: '' });
    h.client.runScript.mockResolvedValue({ response: { scriptError: '3' }, messages: [] });
    const report = (await h.run())!;
    expect(report.steps.find((row) => row.step === 'Optional script')).toMatchObject({ result: 'FAIL', code: '3' });
  });

  it('does not mistake a successful or unrelated failed old-token request for invalidation', async () => {
    const h = harness(); h.client.verifyLoggedOut.mockResolvedValue(undefined);
    const report = (await h.run())!;
    expect(report.steps.find((row) => row.step === 'Old session after logout')?.result).toBe('FAIL');
    expect(report.facts.join(' ')).not.toContain('old token refused');
  });

  it('scrubs hostile FileMaker messages and request dumps, including in structured output', async () => {
    const h = harness();
    h.client.listScripts.mockImplementation(async () => {
      h.setObservation({ status: 500, code: '9', message: 'Authorization: Bearer leaked-token\npassword=leaked-password\n{"token":"leaked-json"}\nCookie: leaked-cookie' });
      throw new FMClientError('Authorization: Basic leaked-basic raw-secret');
    });
    const report = (await h.run())!;
    const text = JSON.stringify(report) + renderSelfTestReport(report);
    expect(text).not.toMatch(/leaked-token|leaked-password|leaked-json|leaked-cookie|leaked-basic|raw-secret/);
    expect(text).toContain('***');
    expect(renderSelfTestReport(report, true)).not.toContain('private.example');
  });
});

it('lists each observed fact once even when more than one check observes it', async () => {
  const h = harness();
  const report = (await h.run())!;
  expect(report.facts.filter((fact) => fact.startsWith('No records:'))).toHaveLength(1);
  const repeated = { ...report, facts: ['No records: HTTP 500, FileMaker 401.', 'No records: HTTP 500, FileMaker 401.'] };
  const markdown = renderSelfTestReport(repeated);
  expect(markdown.split('- No records: HTTP 500, FileMaker 401.')).toHaveLength(2);
});

it('Test My Server counts duplicate fields once, preserving distinct exact names', async () => {
  const { run, client } = harness();
  client.getLayoutMetadata.mockResolvedValue({ fieldMetaData: [{ name: 'Photo', result: 'container' }, { name: 'Photo', result: 'container' }, { name: ' Photo', result: 'container' }] });
  const report = await run();
  expect(report?.facts).toContain(`Layout ${layout}: 2 fields.`);
});
