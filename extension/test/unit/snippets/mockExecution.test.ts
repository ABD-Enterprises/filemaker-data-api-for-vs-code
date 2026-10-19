import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import vm from 'vm';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateSnippet } from '../../../src/snippets';
import type { SnippetFormat, SnippetOperation } from '../../../src/snippets/model';
import type { ConnectionProfile } from '../../../src/types/fm';
import { type RunningMock, startMockProcess } from '../mockServer/mockHelper';
import { parseHttpFile, parsePostman, req, transpile } from './checks';
import { FORMATS } from './fixtures';

/**
 * The copied requests are not only read back, they are sent: each format of each operation is run against the
 * mock Data API (real `curl`, real `fetch`, a real HTTP client for .http and Postman) and the server's answer is
 * compared with the intended effect. The mock follows the Claris Data API Guide (see scripts/mock/ENDPOINTS.md).
 */

const hasCurl = process.platform !== 'win32' && spawnSync('curl', ['--version']).status === 0;
let mock: RunningMock;
let profile: ConnectionProfile;
let cwd: string;
let token: string;

type Json = Record<string, unknown>;
interface Outcome {
  ok: boolean;
  /** `response` of the envelope, or the whole body when there is none. */
  response: Json;
  code: string;
  failure?: string;
}

const env = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  FM_TOKEN: token,
  FM_USERNAME: 'tester',
  FM_PASSWORD: 'testpass1'
});

function outcomeOf(json: Json, status: number): Outcome {
  const messages = (json.messages as Array<{ code: string }> | undefined) ?? [];
  return { ok: status < 400 && messages[0]?.code === '0', response: (json.response as Json) ?? json, code: messages[0]?.code ?? '', failure: undefined };
}

async function runInSandbox(source: string, returns: string): Promise<Outcome> {
  const sandbox: Record<string, unknown> = {
    process: { env: env() },
    Buffer,
    FormData,
    Blob,
    Uint8Array,
    JSON,
    fetch,
    readFile: (path: string) => readFile(join(cwd, path)),
    console: { log: () => undefined }
  };
  const body = source.replace(/^import \{ readFile \} from "node:fs\/promises";$/m, '');
  try {
    const result = (await vm.runInContext(`(async () => {\n${body}\n${returns}\n})()`, vm.createContext(sandbox))) as Json;
    return outcomeOf(result, 200);
  } catch (error) {
    return { ok: false, response: {}, code: '', failure: (error as Error).message };
  }
}

async function replay(request: { method: string; url: string; headers: Array<[string, string]>; body?: string }, upload: boolean): Promise<Outcome> {
  const headers = request.headers.filter(([name]) => !(upload && name === 'Content-Type'));
  let body: string | FormData | undefined = request.body;
  if (upload) {
    const form = new FormData();
    form.append('upload', new Blob([await readFile(join(cwd, 'file-to-upload'))]), 'file-to-upload');
    body = form;
  }
  const response = await fetch(request.url, { method: request.method, headers: Object.fromEntries(headers), body });
  return outcomeOf((await response.json()) as Json, response.status);
}

/** Sends `operation` as `format`. `fill` replaces the variables a reader would fill in (modId). */
async function send(
  operation: SnippetOperation,
  format: SnippetFormat,
  options: { modId?: string; auth?: boolean } = {}
): Promise<Outcome> {
  let text = generateSnippet(profile, operation, format, { includeAuthHeader: options.auth ?? operation.kind !== 'login' });
  if (options.modId !== undefined) {
    text = text.split('<modId>').join(options.modId).split('{{modId}}').join(options.modId);
  }
  const upload = operation.kind === 'uploadContainer';
  switch (format) {
    case 'curl': {
      const run = spawnSync('sh', ['-c', text], { cwd, env: env(), encoding: 'utf8', timeout: 30000 });
      try {
        return outcomeOf(JSON.parse(run.stdout) as Json, 200);
      } catch {
        return { ok: false, response: {}, code: '', failure: `${run.stdout} ${run.stderr}` };
      }
    }
    case 'fetch':
      return runInSandbox(text, 'return data;');
    case 'typescript': {
      const outcome = await runInSandbox(transpile(text), 'return { response };');
      return outcome.failure ? outcome : { ...outcome, ok: true, response: (outcome.response as { response?: Json }).response ?? outcome.response };
    }
    case 'http': {
      // The reader fills in the variables, then the file is read.
      const filled = text.split('{{token}}').join(token).split('{{username}}').join('tester').split('{{password}}').join('testpass1');
      const parsed = parseHttpFile(filled);
      const wire = parsed.wire;
      return replay(
        { method: wire.method, url: wire.url.replace('{{host}}', parsed.variables.host ?? ''), headers: wire.headers, body: wire.body === '<multipart>' ? undefined : wire.body },
        upload
      );
    }
    case 'postman': {
      const parsed = parsePostman(text.split('{{token}}').join(token));
      const wire = parsed.wire;
      return replay({ method: wire.method, url: wire.url, headers: wire.headers, body: wire.body === '<multipart>' ? undefined : wire.body }, upload);
    }
  }
}

beforeAll(async () => {
  if (!hasCurl) return;
  mock = await startMockProcess();
  profile = { id: 'mock', name: 'Mock', authMode: 'direct', serverUrl: mock.baseUrl, database: 'Quality', username: 'tester' };
  cwd = mkdtempSync(join(tmpdir(), 'fm-snippets-run-'));
  writeFileSync(join(cwd, 'file-to-upload'), 'hello container');
  mkdirSync(join(cwd, 'unused'), { recursive: true });
  // The login request, copied as curl and run with the account in the environment, gives the token for the rest.
  const login = await send({ kind: 'login' }, 'curl', { auth: false });
  token = String(login.response.token);
}, 60000);

afterAll(async () => {
  await mock?.stop();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe.skipIf(!hasCurl)('copied requests run against the mock Data API', () => {
  it('login: the account comes from the environment, a session token comes back', () => {
    expect(token.length).toBeGreaterThan(20);
  });

  it.each(FORMATS)('reads: list layouts, list scripts, layout metadata, find and get record as %s', async (format) => {
    const layouts = await send({ kind: 'listLayouts' }, format);
    expect(layouts.ok, layouts.failure).toBe(true);
    expect(JSON.stringify(layouts.response)).toContain('Customers');

    const scripts = await send({ kind: 'listScripts' }, format);
    expect(scripts.ok, scripts.failure).toBe(true);
    expect(JSON.stringify(scripts.response)).toContain('Echo');

    const metadata = await send({ kind: 'layoutMetadata', layout: 'Customers' }, format);
    expect(metadata.ok, metadata.failure).toBe(true);
    expect(metadata.response.fieldMetaData).toBeTruthy();

    const found = await send({ kind: 'find', layout: 'Customers', request: { query: [{ CustomerID: 'C-0001' }], limit: 1 } }, format);
    expect(found.ok, found.failure).toBe(true);
    const row = (found.response.data as Array<{ recordId: string; fieldData: Json }>)[0];
    expect(req(row).fieldData.CustomerID).toBe('C-0001');

    const record = await send({ kind: 'getRecord', layout: 'Customers', recordId: req(row).recordId }, format);
    expect(record.ok, record.failure).toBe(true);
    expect((record.response.data as Array<{ fieldData: Json }>)[0]?.fieldData.CustomerID).toBe('C-0001');
  });

  it.each(FORMATS)('layouts named with a slash, a percent sign and a question mark work as %s', async (format) => {
    for (const layout of ['A/B', 'Percent%20Layout', 'Question?Mark']) {
      const result = await send({ kind: 'find', layout, request: { query: [{}], limit: 1 } }, format);
      expect(result.ok, `${layout}: ${result.failure ?? JSON.stringify(result.response).slice(0, 120)}`).toBe(true);
      expect(JSON.stringify(result.response)).toContain(`"layout":"${layout}"`);
    }
  });

  const params = [
    'plain',
    'a b&c=d/e?f#g%h+i',
    '{"id": 42, "note": "a b&c"}',
    'café \u{1F600} 中文',
    "it's \"quoted\" \\ back",
    '$(touch nope) `touch nope` $HOME',
    '{{token}} {{$processEnv HOME}}',
    'line1\nline2'
  ];

  it.each(FORMATS)('run a script with the documented GET form: the server receives the parameter exactly as %s', async (format) => {
    for (const scriptParam of params) {
      const result = await send({ kind: 'runScript', layout: 'Customers', scriptName: 'Echo', scriptParam }, format);
      expect(result.ok, `${JSON.stringify(scriptParam)}: ${result.failure}`).toBe(true);
      expect(result.response.scriptResult, JSON.stringify(scriptParam)).toBe(scriptParam);
    }
    const noParam = await send({ kind: 'runScript', layout: 'Customers', scriptName: 'Echo' }, format);
    expect(noParam.ok, noParam.failure).toBe(true);
    const named = await send({ kind: 'runScript', layout: 'Customers', scriptName: 'Rebuild Index' }, format);
    expect(named.ok, named.failure).toBe(true);
  });

  it.each(FORMATS)('run a script with a record in context, and with a parameter too long for a URL, as %s', async (format) => {
    const found = await send({ kind: 'find', layout: 'Customers', request: { query: [{ CustomerID: 'C-0001' }], limit: 1 } }, format);
    const recordId = String((found.response.data as Array<{ recordId: string }>)[0]?.recordId);
    const withRecord = await send({ kind: 'runScript', layout: 'Customers', scriptName: 'Echo', scriptParam: 'with record', recordId }, format);
    expect(withRecord.ok, withRecord.failure).toBe(true);
    expect(withRecord.response.scriptResult).toBe('with record');

    const long = 'x'.repeat(2500);
    const viaFind = await send({ kind: 'runScript', layout: 'Customers', scriptName: 'Echo', scriptParam: long }, format);
    expect(viaFind.ok, viaFind.failure).toBe(true);
    expect(viaFind.response.scriptResult).toBe(long);
  });

  it.each(FORMATS)('create, edit with the modId, a stale modId, upload and delete work as %s', async (format) => {
    const created = await send({ kind: 'createRecord', layout: 'A/B', fieldData: { Name: `copy-${format}`, Value: "o'neil $(x)  " } }, format);
    expect(created.ok, created.failure).toBe(true);
    const recordId = String(created.response.recordId);

    const read = async (): Promise<{ modId: string; fieldData: Json }> => {
      const result = await send({ kind: 'getRecord', layout: 'A/B', recordId }, 'curl');
      return req((result.response.data as Array<{ modId: string; fieldData: Json }>)[0]);
    };
    let record = await read();
    expect(record.fieldData.Value).toBe("o'neil $(x)  ");

    const stale = await send({ kind: 'editRecord', layout: 'A/B', recordId, fieldData: { Value: 'stale' } }, format, { modId: '99999' });
    expect(stale.ok, 'a stale modId must be refused').toBe(false);
    expect((await read()).fieldData.Value).toBe("o'neil $(x)  ");

    const edited = await send({ kind: 'editRecord', layout: 'A/B', recordId, fieldData: { Value: `edited by ${format}` } }, format, { modId: record.modId });
    expect(edited.ok, edited.failure).toBe(true);
    record = await read();
    expect(record.fieldData.Value).toBe(`edited by ${format}`);

    const docs = await send({ kind: 'createRecord', layout: 'Documents', fieldData: { Title: `upload-${format}` } }, format);
    const docId = String(docs.response.recordId);
    const uploaded = await send({ kind: 'uploadContainer', layout: 'Documents', recordId: docId, fieldName: 'File' }, format);
    expect(uploaded.ok, uploaded.failure).toBe(true);
    const withModId = await send({ kind: 'uploadContainer', layout: 'Documents', recordId: docId, fieldName: 'File', withModId: true }, format, { modId: '99999' });
    expect(withModId.ok, 'a stale modId on an upload must be refused').toBe(false);

    for (const [layout, id] of [['A/B', recordId], ['Documents', docId]]) {
      const deleted = await send({ kind: 'deleteRecord', layout: req(layout), recordId: req(id) }, format);
      expect(deleted.ok, deleted.failure).toBe(true);
    }
    const gone = await send({ kind: 'getRecord', layout: 'A/B', recordId }, 'curl');
    expect(gone.ok).toBe(false);
  });

  it('the default copy (no auth opt-in) is refused by the server: it holds no token', async () => {
    const refused = await send({ kind: 'listLayouts' }, 'curl', { auth: false });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('952');
  });
});
