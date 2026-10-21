import { randomUUID } from 'crypto';

import type { FMClient } from './fmClient';
import { FMClientError } from './errors';
import type { ConnectionProfile } from '../types/fm';
import { getFileMakerErrorInfo } from '../utils/fileMakerCodes';
import { redactString } from '../utils/redact';
import { extractScriptErrors } from './responseGuard';

export interface SelfTestObservation {
  status?: number;
  code?: string;
  message?: string;
  tls?: string;
}
export interface SelfTestClient extends Pick<FMClient,
  'getProductInfo' | 'createSession' | 'listHostedDatabases' | 'listLayouts' | 'listScripts' |
  'getLayoutMetadata' | 'findRecords' | 'getRecord' | 'createRecord' | 'editRecord' |
  'deleteRecord' | 'runScript' | 'deleteSession'> {
  resetObservation(): void;
  observation(): SelfTestObservation;
  verifyLoggedOut(profile: ConnectionProfile, token: string, signal?: AbortSignal): Promise<void>;
  scrub(text: string): string;
}
export interface SelfTestUi {
  start(): Promise<'read' | 'write' | undefined>;
  pickLayout(layouts: string[], scratch: boolean): Promise<string | undefined>;
  pickField(fields: string[], scratch: boolean): Promise<string | undefined>;
  confirmWrite(layout: string): Promise<boolean>;
  script(): Promise<{ name: string; parameter: string } | undefined>;
  confirmScript(name: string): Promise<boolean>;
  allowed(kind: 'read' | 'write' | 'script'): boolean;
  progress(step: string): void;
}
export interface SelfTestStep extends SelfTestObservation {
  step: string;
  result: 'PASS' | 'WARN' | 'FAIL';
  ms: number;
  note: string;
}
export interface SelfTestReport {
  server: string;
  steps: SelfTestStep[];
  facts: string[];
  problems: string[];
}

class Stopped extends Error {}

/** No record values, credentials, script parameters or script results are put in the report. */
export async function testMyServer(
  client: SelfTestClient, profile: ConnectionProfile, ui: SelfTestUi, signal: AbortSignal
): Promise<SelfTestReport | undefined> {
  if (signal.aborted || !ui.allowed('read')) return undefined;
  const mode = await ui.start();
  if (!mode) return undefined;
  const report: SelfTestReport = { server: profile.serverUrl, steps: [], facts: [], problems: [] };
  const control = { signal };
  let token: string | undefined;
  let loginAttempted = false;
  const check = () => {
    if (signal.aborted || !ui.allowed('read')) throw new Stopped();
  };
  const skip = (step: string, note: string) => report.steps.push({ step, result: 'WARN', ms: 0, note });
  const step = async <T>(name: string, action: () => Promise<T>, expected?: string, finishing = false): Promise<T | undefined> => {
    if (!finishing) check();
    ui.progress(name);
    client.resetObservation();
    const start = Date.now();
    try {
      const value = await action();
      const observed = client.observation();
      const result = expected && observed.code !== expected ? 'WARN' : 'PASS';
      report.steps.push({ step: name, result, ms: Date.now() - start, ...observed, note: result === 'WARN' ? `Expected FileMaker code ${expected} was not returned.` : 'Completed.' });
      if (observed.tls && !report.facts.includes(`TLS protocol: ${observed.tls}`)) report.facts.push(`TLS protocol: ${observed.tls}`);
      if (observed.code === '401') report.facts.push(`No records: HTTP ${observed.status ?? 'unknown'}, FileMaker ${observed.code}.`);
      return value;
    } catch (error) {
      const observed = client.observation();
      const failure = error instanceof FMClientError ? error : undefined;
      const code = failure?.code ?? observed.code;
      const status = failure?.status ?? observed.status;
      const passed = expected !== undefined && code === expected;
      // Unknown exceptions may contain arbitrary request dumps. Only print the server's
      // FileMaker message (scrubbed at render), or our own plain advice for other errors.
      const note = (observed.code === code ? observed.message : undefined) ?? (code ? getFileMakerErrorInfo(code)?.meaning : undefined) ?? 'The request did not finish. Check the connection, certificate, account and timeout settings.';
      report.steps.push({ step: name, result: passed ? 'PASS' : 'FAIL', ms: Date.now() - start, status, code, message: observed.code === code ? observed.message : undefined, note });
      if (passed && expected === '306') report.facts.push(`Stale edit: HTTP ${status ?? 'unknown'}, FileMaker ${code}.`);
      if (!passed) report.problems.push(`${name}: ${note} ${code ? getFileMakerErrorInfo(code)?.advice ?? 'Ask your FileMaker administrator to check this step.' : ''}`);
      if (signal.aborted && !finishing) throw new Stopped();
      return undefined;
    }
  };
  const metadata = async (layout: string) => step(`Layout metadata: ${layout}`, async () => {
    const data = await client.getLayoutMetadata(profile, layout, control);
    const fields = textFields(data);
    const count = Array.isArray(data.fieldMetaData) ? data.fieldMetaData.length : 0;
    report.facts.push(`Layout ${layout}: ${count} fields.`);
    return fields;
  });
  try {
    check();
    const product = await step('Product info (without login)', () => client.getProductInfo(profile, control));
    if (product) report.facts.push(`Server version: ${product.version ?? 'not supplied'}.`);
    loginAttempted = true;
    token = await step('Log in', () => client.createSession(profile, { ...control, userInitiated: true }));
    if (!token) {
      skip('Remaining tests', 'Skipped: sign-in did not return a session. Check the account, password and Data API access.');
      return report;
    }
    const databases = await step('List databases', () => client.listHostedDatabases(profile, control));
    if (!databases) {
      const row = report.steps[report.steps.length - 1]!;
      if (row.result !== 'FAIL' || [401, 403, 405, 501].includes(row.status ?? 0)) {
        row.result = 'WARN';
        row.note = 'Database listing is unavailable to this account or server; ask an administrator if needed.';
        report.problems = report.problems.filter((problem) => !problem.startsWith('List databases:'));
      }
    }
    const layouts = await step('List layouts', () => client.listLayouts(profile, control)) ?? [];
    report.facts.push(`Layout count: ${report.steps.at(-1)?.result === 'PASS' ? layouts.length : 'not observed'}.`);
    const scripts = await step('List scripts (count only)', () => client.listScripts(profile, control));
    if (scripts) report.facts.push(`Script count: ${scripts.length}.`);
    const fields = new Map<string, string[]>();
    for (const layout of layouts.slice(0, 3)) fields.set(layout, await metadata(layout) ?? []);
    check();
    const layout = await ui.pickLayout(layouts, false);
    check();
    if (layout !== undefined && layouts.includes(layout)) {
      const found = await step('Read-only find (limit 1)', () => client.findRecords(profile, layout, { query: [{}], limit: 1 }, control));
      const first = found?.data[0];
      if (first) await step('Get found record by ID', () => client.getRecord(profile, layout, first.recordId, control));
      else skip('Get found record by ID', 'No record was found.');
      if (!fields.has(layout)) fields.set(layout, await metadata(layout) ?? []);
      check();
      const field = await ui.pickField(fields.get(layout) ?? [], false);
      check();
      if (field !== undefined && fields.get(layout)?.includes(field)) {
        await step('No-records error check', () => client.findRecords(profile, layout, { query: [{ [field]: `==__FileMaker_self_test_${randomUUID()}__` }], limit: 1 }, control), '401');
      } else skip('No-records error check', 'Skipped: no text field chosen.');
    } else {
      skip('Read-only find / get / no-records check', 'Skipped: no layout chosen.');
    }
    check();
    if (mode === 'write' && ui.allowed('write')) {
      const scratch = await ui.pickLayout(layouts, true);
      check();
      if (scratch !== undefined && layouts.includes(scratch)) {
        const scratchFields = await metadata(scratch) ?? [];
        check();
        const field = await ui.pickField(scratchFields, true);
        check();
        if (field !== undefined && scratchFields.includes(field) && await ui.confirmWrite(scratch)) {
          check();
          let id: string | undefined;
          try {
            if (!ui.allowed('write')) throw new Stopped();
            const created = await step('Create scratch record', () => client.createRecord(profile, scratch, { [field]: 'FileMaker server test' }, control));
            id = created?.recordId;
            if (!id) report.problems.push('Create did not return a record ID. If the server accepted it before the connection stopped, a test record may remain. Check the SCRATCH layout before trying again.');
            if (id) {
              const record = await step('Get scratch record', () => client.getRecord(profile, scratch, id!, control));
              if (record?.modId !== undefined) {
                if (!ui.allowed('write')) throw new Stopped();
                const edited = await step('Edit scratch record with modId', () => client.editRecord(profile, scratch, id!, { [field]: 'FileMaker server test edited' }, control, { modId: record.modId }));
                if (edited) {
                  if (!ui.allowed('write')) throw new Stopped();
                  await step('Stale-modId error check', () => client.editRecord(profile, scratch, id!, { [field]: 'FileMaker server test stale' }, control, { modId: record.modId }), '306');
                }
              } else skip('Edit / stale-modId check', 'No modification ID was returned; unsafe edits skipped.');
            }
          } finally {
            if (id) {
              const removed = await step('Delete scratch record (cleanup)', () => client.deleteRecord(profile, scratch, id!), undefined, true);
              if (!removed) report.problems.push(`Remove test record ID ${id} from layout ${scratch}: cleanup did not succeed. Ask your administrator to remove it.`);
            }
          }
        } else skip('Write test', 'Skipped: field selection or second confirmation was not given.');
      } else skip('Write test', 'Skipped: no SCRATCH layout chosen.');
    } else skip('Write test', 'Skipped: read-only choice, Restricted Mode, role, offline mode or write switch.');
    check();
    if (layout !== undefined && ui.allowed('script')) {
      const script = await ui.script();
      check();
      if (script && await ui.confirmScript(script.name)) {
        check();
        if (ui.allowed('script')) await step('Optional script', async () => {
          const result = await client.runScript(profile, { layout, scriptName: script.name, scriptParam: script.parameter }, control);
          const errors = extractScriptErrors(result.response);
          if (errors.length) throw new FMClientError('Script reported an error.', { code: errors[0]!.code });
        });
        else skip('Optional script', 'Skipped: script permission changed before the request.');
      } else skip('Optional script', 'Skipped: no script typed and confirmed.');
    } else skip('Optional script', 'Skipped: no layout, Restricted Mode, role or script switch.');
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    skip('Remaining tests', 'Stopped by cancellation or offline mode. Only cleanup and logout are attempted.');
  } finally {
    if (loginAttempted) {
      await step('Log out', () => client.deleteSession(profile), undefined, true);
      if (token && profile.authMode !== 'proxy' && !signal.aborted && ui.allowed('read')) {
        await step('Old session after logout', async () => {
          try {
            await client.verifyLoggedOut(profile, token!, signal);
          } catch (error) {
            const observed = client.observation();
            if (observed.code === '952') {
              report.facts.push(`Session behavior: old token refused after logout (HTTP ${observed.status ?? 'unknown'}, FileMaker 952).`);
              return;
            }
            throw error;
          }
          throw new FMClientError('Old session still accepted.');
        }, undefined, true);
      } else skip('Old session after logout', 'Skipped: proxy controls its own session, login failed, canceled or offline.');
    }
    for (const [prefix, unknown] of [
      ['Server version:', 'Server version: not observed.'],
      ['TLS protocol:', 'TLS protocol: not observed (plain HTTP or unavailable).'],
      ['Layout count:', 'Layout count: not observed.'],
      ['Script count:', 'Script count: not observed.'],
      ['No records:', 'No records: HTTP status and FileMaker code not observed.'],
      ['Stale edit:', 'Stale edit: conflict code not observed (write test skipped or incomplete).'],
      ['Session behavior:', 'Session behavior: invalidation after logout not confirmed.']
    ]) {
      if (!report.facts.some((fact) => fact.startsWith(prefix!))) report.facts.push(unknown!);
    }
    // Sanitize the structured result too, not only the markdown and clipboard.
    const scrub = (text: string) => redactString(client.scrub(text)).replace(
      /(\b(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1***');
    report.server = scrub(report.server);
    report.facts = report.facts.map(scrub);
    report.problems = report.problems.map(scrub);
    report.steps = report.steps.map((row) => ({ ...row, step: scrub(row.step), note: scrub(row.note),
      code: row.code === undefined ? undefined : scrub(row.code),
      message: row.message === undefined ? undefined : scrub(row.message),
      tls: row.tls === undefined ? undefined : scrub(row.tls) }));
  }
  return report;
}

function textFields(metadata: Record<string, unknown>): string[] {
  if (!Array.isArray(metadata.fieldMetaData)) return [];
  return metadata.fieldMetaData.filter((field): field is { name: string } =>
    typeof field?.name === 'string' && field.result === 'text' &&
    (field.type === 'normal' || field.type === undefined) && !field.global && !field.name.includes('::')
  ).map((field) => field.name);
}

export function renderSelfTestReport(report: SelfTestReport, maskServer = false): string {
  const cell = (value: unknown) => String(value ?? '—').replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '');
  const address = maskServer ? '[server address hidden]' : cell(report.server);
  let text = `# FileMaker: Test My Server\n\nServer: ${address}\n\n| Step | Result | ms | HTTP | FileMaker code | Message | Notes |\n| --- | --- | ---: | --- | --- | --- | --- |\n`;
  for (const row of report.steps) text += `| ${cell(row.step)} | ${row.result} | ${row.ms} | ${cell(row.status)} | ${cell(row.code)} | ${cell(row.message)} | ${cell(row.note)} |\n`;
  text += `\n## Facts observed on this server\n\n${report.facts.map((fact) => `- ${cell(fact)}`).join('\n')}\n\n## Problems\n\n${report.problems.length ? report.problems.map((problem) => `- ${cell(problem)}`).join('\n') : 'No failed steps. WARN rows describe skipped or unverified checks.'}\n`;
  if (maskServer) {
    text = text.split(report.server).join('[server address hidden]');
    try { text = text.split(new URL(report.server).host).join('[server address hidden]'); } catch { /* Invalid addresses are already reported by the client. */ }
  }
  return redactString(text);
}
