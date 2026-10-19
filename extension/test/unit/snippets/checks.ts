/**
 * Round-trip checks for the copied requests: each format is read back by a real consumer (a POSIX
 * shell running a fake curl, a JavaScript engine with a fake fetch, a `.http` and a Postman parser, the
 * TypeScript compiler) and compared with the request that was meant. The same checks run against
 * deliberately weakened escapes in the mutation test, which must make them fail.
 */
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { stripTypeScriptTypes } from 'module';
import { tmpdir } from 'os';
import { join } from 'path';
import vm from 'vm';


import type { ConnectionProfile } from '../../../src/types/fm';
import type { SnippetFormat, SnippetOperation, SnippetOptions } from '../../../src/snippets/model';
import { redactValue } from '../../../src/utils/redact';


/** The value, or a clear failure (the tests index lists they have just built). */
export function req<T>(value: T | undefined, what = 'value'): T {
  if (value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

export type Generate = (
  profile: ConnectionProfile,
  operation: SnippetOperation,
  format: SnippetFormat,
  options?: SnippetOptions
) => string;

/** What a request looks like on the wire, as each consumer reads it back. */
export interface Wire {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  /** The raw body text, or `<multipart>` for a file upload. */
  body?: string;
}

const enc = encodeURIComponent;

/** The request that is meant, worked out here (not by the code under test) from the rules the client follows. */
export function intendedWire(profile: ConnectionProfile, op: SnippetOperation, includeAuth: boolean, token = 'TESTTOKEN'): Wire {
  const host = profile.serverUrl.replace(/\/+$/, '');
  const base = `${host}/fmi/data/vLatest/databases/${enc(profile.database)}`;
  const auth: [string, string] = ['Authorization', includeAuth ? `Bearer ${token}` : 'Bearer <REDACTED>'];
  const json: [string, string] = ['Content-Type', 'application/json'];
  const layout = 'layout' in op ? `${base}/layouts/${enc(op.layout)}` : '';
  switch (op.kind) {
    case 'find':
      return { method: 'POST', url: `${layout}/_find`, headers: [json, auth], body: JSON.stringify(redactValue(op.request)) };
    case 'getRecord':
      return { method: 'GET', url: `${layout}/records/${enc(op.recordId)}`, headers: [auth] };
    case 'createRecord':
      return { method: 'POST', url: `${layout}/records`, headers: [json, auth], body: JSON.stringify({ fieldData: redactValue(op.fieldData) }) };
    case 'editRecord':
      return {
        method: 'PATCH',
        url: `${layout}/records/${enc(op.recordId)}`,
        headers: [json, auth],
        body: JSON.stringify({ fieldData: redactValue(op.fieldData), modId: '<modId>' })
      };
    case 'deleteRecord':
      return { method: 'DELETE', url: `${layout}/records/${enc(op.recordId)}`, headers: [auth] };
    case 'runScript': {
      const param = op.scriptParam ? `script.param=${enc(op.scriptParam)}` : '';
      if (op.recordId) {
        return {
          method: 'GET',
          url: `${layout}/records/${enc(op.recordId)}?script=${enc(op.scriptName)}${param ? `&${param}` : ''}`,
          headers: [auth]
        };
      }
      return { method: 'GET', url: `${layout}/script/${enc(op.scriptName)}${param ? `?${param}` : ''}`, headers: [auth] };
    }
    case 'layoutMetadata':
      return { method: 'GET', url: layout, headers: [auth] };
    case 'uploadContainer':
      return {
        method: 'POST',
        url: `${layout}/records/${enc(op.recordId)}/containers/${enc(op.fieldName)}/${op.fieldRepetition ?? 1}${op.withModId ? '?modId=<modId>' : ''}`,
        headers: [auth],
        body: '<multipart>'
      };
    case 'listLayouts':
      return { method: 'GET', url: `${base}/layouts`, headers: [auth] };
    case 'listScripts':
      return { method: 'GET', url: `${base}/scripts`, headers: [auth] };
    case 'login':
      return { method: 'POST', url: `${base}/sessions`, headers: [json, ['Authorization', 'Basic TESTUSER:TESTPASSWORD']], body: '{}' };
  }
}

export function compareWire(actual: Wire, intended: Wire, options: { bodyAsJson: boolean }): string[] {
  const problems: string[] = [];
  if (actual.method !== intended.method) problems.push(`method ${actual.method} != ${intended.method}`);
  if (actual.url !== intended.url) problems.push(`url ${actual.url} != ${intended.url}`);
  const header = (list: Array<[string, string]>): string => JSON.stringify([...list].sort((a, b) => a[0].localeCompare(b[0])));
  if (header(actual.headers) !== header(intended.headers)) problems.push(`headers ${header(actual.headers)} != ${header(intended.headers)}`);
  if (intended.body === undefined) {
    if (actual.body !== undefined && actual.body !== '') problems.push(`unexpected body ${actual.body}`);
  } else if (options.bodyAsJson && intended.body !== '<multipart>') {
    try {
      if (JSON.stringify(JSON.parse(actual.body ?? 'null')) !== JSON.stringify(JSON.parse(intended.body))) {
        problems.push(`body ${actual.body} != ${intended.body}`);
      }
    } catch {
      problems.push(`body is not JSON: ${actual.body}`);
    }
  } else if (actual.body !== intended.body) {
    problems.push(`body ${actual.body} != ${intended.body}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// curl: syntax check, then a real `sh` run with a fake curl that dumps its arguments
// ---------------------------------------------------------------------------------------------

let workDir: string | undefined;

export function scratch(): string {
  workDir ??= mkdtempSync(join(tmpdir(), 'fm-snippets-'));
  return workDir;
}

export function cleanupScratch(): void {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
}

export function bashSyntaxProblems(script: string, shell = 'bash'): string[] {
  const file = join(scratch(), 'snippet.sh');
  writeFileSync(file, script, 'utf8');
  const result = spawnSync(shell, ['-n', file], { encoding: 'utf8' });
  return result.status === 0 ? [] : [`${shell} -n: ${result.stderr.trim()}`];
}

/** Runs the curl command under `sh` with a fake `curl` first on PATH; returns the arguments curl would have received. */
export function runCurl(script: string, env: Record<string, string> = {}, shell = 'sh'): { args: string[]; stderr: string } {
  const dir = scratch();
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const dump = join(dir, 'argv.bin');
  rmSync(dump, { force: true });
  const fake = join(bin, 'curl');
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${dump}"\n`, 'utf8');
  chmodSync(fake, 0o755);
  const file = join(dir, 'run.sh');
  writeFileSync(file, script, 'utf8');
  const result = spawnSync(shell, [file], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env }
  });
  let args: string[] = [];
  try {
    args = readFileSync(dump, 'utf8').split('\0');
    args.pop();
  } catch {
    // The fake curl never ran.
  }
  return { args, stderr: result.stderr };
}

export function wireFromCurl(args: string[]): Wire {
  const wire: Wire = { method: '', url: '', headers: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-X') wire.method = req(args[++index]);
    else if (arg === '-H') {
      const text = req(args[++index]);
      const colon = text.indexOf(':');
      wire.headers.push([text.slice(0, colon), text.slice(colon + 1).trim()]);
    } else if (arg === '--data-raw') wire.body = req(args[++index]);
    else if (arg === '-F') {
      index += 1;
      wire.body = '<multipart>';
    }
    else if (arg === '-u') {
      wire.headers.push(['Authorization', `Basic ${args[++index]}`]);
    } else wire.url = req(arg);
  }
  return wire;
}

// ---------------------------------------------------------------------------------------------
// fetch() and TypeScript: evaluated in a sandbox with a fake fetch
// ---------------------------------------------------------------------------------------------

export async function runScriptSnippet(
  source: string,
  env: Record<string, string> = {}
): Promise<{ wire: Wire; parsedLiteral: boolean }> {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const sandbox: Record<string, unknown> = {
    process: { env },
    Buffer,
    FormData,
    Blob,
    Uint8Array,
    JSON,
    console: { log: () => undefined },
    fetch: async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ response: {}, messages: [] }) };
    }
  };
  const context = vm.createContext(sandbox);
  const body = source.replace(/^import \{ readFile \} from "node:fs\/promises";$/m, 'const readFile = async () => Buffer.from("file");');
  // The whole snippet is one async function: it uses top-level await like a module would.
  await vm.runInContext(`(async () => {\n${body}\n})()`, context);
  const call = req(calls[0], 'fetch call');
  const headers = Object.entries((call.init.headers ?? {}) as Record<string, string>) as Array<[string, string]>;
  const isForm = call.init.body instanceof FormData;
  return {
    wire: {
      method: String(call.init.method),
      url: call.url,
      headers,
      body: isForm ? '<multipart>' : (call.init.body as string | undefined)
    },
    parsedLiteral: true
  };
}

/** Removes the type syntax so the snippet can run (Node's own stripper; the snippets use no enums or namespaces). */
export function transpile(source: string): string {
  return stripTypeScriptTypes(source);
}

/**
 * Type errors of TypeScript snippets, by name: all are compiled by one run of the project's own `tsc`
 * as modules in strict mode with the DOM and Node typings.
 */
export function typeErrors(sources: Record<string, string>): Record<string, string[]> {
  const dir = join(scratch(), `ts-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const extensionRoot = join(__dirname, '..', '..', '..');
  const names = Object.keys(sources);
  names.forEach((name, index) => writeFileSync(join(dir, `s${index}.ts`), req(sources[name]), 'utf8'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        moduleDetection: 'force',
        lib: ['ES2022', 'DOM'],
        types: ['node'],
        typeRoots: [join(extensionRoot, 'node_modules', '@types'), join(extensionRoot, '..', 'node_modules', '@types')],
        strict: true,
        noEmit: true,
        skipLibCheck: true
      },
      include: ['*.ts']
    }),
    'utf8'
  );
  const result = spawnSync(join(extensionRoot, 'node_modules', '.bin', 'tsc'), ['-p', dir, '--pretty', 'false'], { encoding: 'utf8' });
  const errors: Record<string, string[]> = Object.fromEntries(names.map((name) => [name, []]));
  for (const line of `${result.stdout}${result.stderr}`.split('\n')) {
    const match = /^(?:.*[\\/])?s(\d+)\.ts\((\d+),(\d+)\): error (.*)$/.exec(line);
    if (match) {
      req(errors[req(names[Number(match[1])])]).push(`line ${match[2]}: ${match[4]}`);
    } else if (/error TS/.test(line)) {
      req(errors[req(names[0])]).push(line);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// .http and Postman: parsed back
// ---------------------------------------------------------------------------------------------

export const ALLOWED_TEMPLATES = new Set(['host', 'token', 'modId', 'username', 'password', 'proxyApiKey', 'baseUrl']);

export function unexpectedTemplates(text: string): string[] {
  return [...text.matchAll(/\{\{([^}]*)\}\}/g)].map((match) => match[1] ?? '').filter((name) => !ALLOWED_TEMPLATES.has(name));
}

export function parseHttpFile(text: string): { wire: Wire; requestCount: number; variables: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  if (text.includes('\r')) problems.push('contains a carriage return');
  const lines = text.split('\n');
  const variables: Record<string, string> = {};
  let index = 0;
  while (index < lines.length && !(lines[index] ?? '').startsWith('###')) {
    const match = /^@(\w+) = (.*)$/.exec(lines[index] ?? '');
    if (match) variables[req(match[1])] = req(match[2]);
    index += 1;
  }
  const separators = lines.filter((line) => line.startsWith('###')).length;
  index += 1;
  const requestLine = /^([A-Z]+) (\S+)$/.exec(lines[index] ?? '');
  if (!requestLine) problems.push(`bad request line: ${lines[index]}`);
  index += 1;
  const headers: Array<[string, string]> = [];
  while (index < lines.length && lines[index] !== '') {
    const line = lines[index] ?? '';
    const colon = line.indexOf(':');
    headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
    index += 1;
  }
  const body = lines.slice(index + 1).join('\n').replace(/\n+$/, '');
  const multipart = headers.some(([name, value]) => name === 'Content-Type' && value.startsWith('multipart/form-data'));
  const url = (requestLine?.[2] ?? '').replace('{{host}}', variables.host ?? '');
  // The consumer would substitute the variables a reader fills in.
  const substitute = (value: string): string =>
    value
      .replace('{{token}}', 'TESTTOKEN')
      .replace('{{proxyApiKey}}', 'TESTTOKEN')
      .replace('{{username}}', 'TESTUSER')
      .replace('{{password}}', 'TESTPASSWORD')
      .replace(/\{\{modId\}\}/g, '<modId>');
  return {
    wire: {
      method: requestLine?.[1] ?? '',
      url: substitute(url),
      // curl and fetch() let the library set a multipart Content-Type; the file names its boundary itself.
      headers: headers
        .filter(([name]) => !(multipart && name === 'Content-Type'))
        .map(([name, value]): [string, string] => [name, substitute(value)]),
      body: multipart ? '<multipart>' : body === '' ? undefined : substitute(body)
    },
    requestCount: separators,
    variables,
    problems
  };
}

export function parsePostman(text: string): { wire: Wire; problems: string[]; strings: string[] } {
  const problems: string[] = [];
  const collection = JSON.parse(text) as {
    info: { schema: string };
    item: Array<{ name: string; request: Record<string, unknown> }>;
    variable: Array<{ key: string; value: string }>;
  };
  if (collection.info.schema !== 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json') problems.push('schema');
  if (collection.item.length !== 1) problems.push(`items: ${collection.item.length}`);
  const variables = Object.fromEntries(collection.variable.map((entry) => [entry.key, entry.value]));
  const request = req(collection.item[0]).request as {
    method: string;
    header: Array<{ key: string; value: string }>;
    url: string;
    body?: { mode: string; raw?: string };
    auth?: { type: string };
  };
  const substitute = (value: string): string =>
    value
      .replace('{{baseUrl}}', variables.baseUrl ?? '')
      .replace('{{token}}', 'TESTTOKEN')
      .replace('{{proxyApiKey}}', 'TESTTOKEN')
      .replace(/\{\{modId\}\}/g, '<modId>');
  const headers: Array<[string, string]> = request.header.map((header) => [header.key, substitute(header.value)]);
  if (request.auth?.type === 'basic') headers.push(['Authorization', 'Basic TESTUSER:TESTPASSWORD']);
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(collection);
  return {
    wire: {
      method: request.method,
      url: substitute(request.url),
      headers,
      body: request.body?.mode === 'formdata' ? '<multipart>' : request.body?.raw === undefined ? undefined : substitute(request.body.raw)
    },
    problems,
    strings
  };
}

// ---------------------------------------------------------------------------------------------
// All formats for one case
// ---------------------------------------------------------------------------------------------

export interface CaseResult {
  format: SnippetFormat;
  problems: string[];
}

/** Generates `operation` in every format, reads each back, and returns the problems found (none when the quoting is inert). */
export async function roundTrip(
  generate: Generate,
  profile: ConnectionProfile,
  operation: SnippetOperation,
  options: { includeAuth: boolean; pwnFile: string }
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const intended = intendedWire(profile, operation, options.includeAuth);
  const env = { FM_TOKEN: 'TESTTOKEN', FM_USERNAME: 'TESTUSER', FM_PASSWORD: 'TESTPASSWORD' };
  const intendedLogin = operation.kind === 'login';
  const push = (format: SnippetFormat, problems: string[]): void => {
    results.push({ format, problems });
  };

  // curl
  {
    const text = generate(profile, operation, 'curl', { includeAuthHeader: options.includeAuth });
    const problems = [...bashSyntaxProblems(text, 'bash'), ...bashSyntaxProblems(text, 'sh')];
    const run = runCurl(text, env);
    if (run.args.length === 0) problems.push(`the fake curl never ran: ${run.stderr}`);
    else problems.push(...compareWire(wireFromCurl(run.args), intended, { bodyAsJson: true }));
    push('curl', problems);
  }
  // fetch() and TypeScript
  for (const format of ['fetch', 'typescript'] as const) {
    const text = generate(profile, operation, format, { includeAuthHeader: options.includeAuth });
    const problems: string[] = [];
    if (/\u2028|\u2029/.test(text)) problems.push('raw U+2028/U+2029 in the source');
    if (/<\/script/i.test(text)) problems.push('contains </script');
    try {
      const source = format === 'typescript' ? transpile(text) : text;
      const { wire } = await runScriptSnippet(source, intendedLogin ? { ...env } : { ...env });
      problems.push(...compareWire(wire, intendedForScript(intended, format, intendedLogin), { bodyAsJson: true }));
    } catch (error) {
      problems.push(`evaluation failed: ${(error as Error).message}`);
    }
    push(format, problems);
  }
  // .http
  {
    const text = generate(profile, operation, 'http', { includeAuthHeader: options.includeAuth });
    const parsed = parseHttpFile(text);
    const problems = [...parsed.problems];
    if (parsed.requestCount !== 1) problems.push(`${parsed.requestCount} requests in the file`);
    const stray = unexpectedTemplates(text);
    if (stray.length > 0) problems.push(`a tool would expand: ${stray.join(', ')}`);
    problems.push(...compareWire(parsed.wire, intended, { bodyAsJson: true }));
    push('http', problems);
  }
  // Postman
  {
    const text = generate(profile, operation, 'postman', { includeAuthHeader: options.includeAuth });
    const problems: string[] = [];
    try {
      const parsed = parsePostman(text);
      problems.push(...parsed.problems);
      const stray = parsed.strings.flatMap((value) => unexpectedTemplates(value));
      if (stray.length > 0) problems.push(`a tool would expand: ${stray.join(', ')}`);
      problems.push(...compareWire(parsed.wire, intended, { bodyAsJson: true }));
    } catch (error) {
      problems.push(`not valid Postman JSON: ${(error as Error).message}`);
    }
    push('postman', problems);
  }
  // Nothing may have run: the hostile text contains commands that would create this file.
  try {
    readFileSync(options.pwnFile);
    results.push({ format: 'curl', problems: [`the command ran: ${options.pwnFile} exists`] });
  } catch {
    // Good: it does not exist.
  }
  return results;
}

/** fetch() and TypeScript send the Basic login through a computed header and the body as given: the intended wire differs only for login. */
function intendedForScript(intended: Wire, _format: SnippetFormat, login: boolean): Wire {
  if (!login) return intended;
  const basic = `Basic ${Buffer.from('TESTUSER:TESTPASSWORD').toString('base64')}`;
  return { ...intended, headers: intended.headers.map(([name, value]) => (name === 'Authorization' ? [name, basic] : [name, value])) };
}
