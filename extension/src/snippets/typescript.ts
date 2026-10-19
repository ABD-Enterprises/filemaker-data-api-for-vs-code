import { jsString, prefixedLines, safeJson } from './escape';
import type { RequestSpec, ResponseKind, SnippetOptions } from './model';
import { bodyJson, hasProtoKey, pathAndQuery } from './render';

const STYLE = { modId: '<modId>' };

const RECORD = '{ recordId: string; modId: string; fieldData: Record<string, unknown>; portalData?: Record<string, unknown[]> }';

const RESPONSE_TYPES: Record<ResponseKind, string> = {
  session: '{ token: string }',
  records: `{ data: Array<${RECORD}>; dataInfo?: Record<string, unknown>; scriptResult?: string; scriptError?: string }`,
  created: '{ recordId: string; modId: string }',
  modified: '{ modId?: string }',
  empty: 'Record<string, never>',
  script: '{ scriptResult?: string; scriptError?: string }',
  layouts: '{ layouts: Array<{ name: string; isFolder?: boolean; folderLayoutNames?: unknown[] }> }',
  scripts: '{ scripts: Array<{ name: string; isFolder?: boolean; folderScriptNames?: unknown[] }> }',
  metadata: '{ fieldMetaData: Array<Record<string, unknown>>; portalMetaData?: Record<string, unknown> }',
  proxy: 'unknown'
};

/**
 * A typed `fetch` wrapper with the one call. The generated client of "Generate TypeScript Client"
 * needs the layout's generated types and has no calls for scripts, sessions, modId or containers,
 * so the call does not map onto it cleanly; this snippet stands alone instead.
 */
export function renderTypeScript(spec: RequestSpec, options: SnippetOptions = {}): string {
  const lines: string[] = spec.notes.flatMap((note) => prefixedLines('// ', note));
  if (spec.body?.kind === 'upload') {
    lines.push('import { readFile } from "node:fs/promises";', '');
  }

  lines.push(
    'interface DataApiEnvelope<T> {',
    '  response: T;',
    '  messages: Array<{ code: string; message: string }>;',
    '}',
    '',
    `const host = ${jsString(spec.host)};`
  );

  if (spec.auth === 'basic') {
    lines.push(
      'const basic = Buffer.from(`${process.env.FM_USERNAME ?? "<account name>"}:${process.env.FM_PASSWORD ?? "<password>"}`).toString("base64");',
      'const authorization = `Basic ${basic}`;'
    );
  } else if (options.includeAuthHeader) {
    const variable = spec.auth === 'proxy' ? 'FM_PROXY_API_KEY' : 'FM_TOKEN';
    const fallback = spec.auth === 'proxy' ? '<proxy api key>' : '<session token>';
    lines.push(
      `const token = process.env.${variable} ?? ${jsString(fallback)};`,
      'const authorization = `Bearer ${token}`;'
    );
  } else {
    lines.push(`const authorization = ${jsString('Bearer <REDACTED>')};`);
  }

  lines.push(
    '',
    'async function dataApi<T>(method: string, path: string, body?: unknown): Promise<DataApiEnvelope<T>> {',
    '  const isForm = body instanceof FormData;',
    '  const response = await fetch(`${host}${path}`, {',
    '    method,',
    '    headers: body === undefined || isForm ? { Authorization: authorization } : { "Content-Type": "application/json", Authorization: authorization },',
    '    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)',
    '  });',
    '  const envelope = (await response.json()) as DataApiEnvelope<T>;',
    '  if (!response.ok) {',
    '    throw new Error(`Data API request failed (${response.status}): ${envelope.messages?.map((m) => m.message).join("; ")}`);',
    '  }',
    '  return envelope;',
    '}',
    ''
  );

  const call = `${jsString(spec.method)}, ${jsString(pathAndQuery(spec, STYLE))}`;
  const responseType = RESPONSE_TYPES[spec.response];

  if (spec.body?.kind === 'upload') {
    lines.push(
      'const form = new FormData();',
      'form.append("upload", new Blob([new Uint8Array(await readFile("./file-to-upload"))]), "file-to-upload");',
      `const { response } = await dataApi<${responseType}>(${call}, form);`
    );
  } else if (spec.body?.kind === 'json') {
    const placeholderLiteral = (name: string): string => safeJson(`<${name}>`);
    const compact = bodyJson(spec.body.value, { placeholderLiteral });
    // A JavaScript object literal turns a key called __proto__ into a prototype, so that body is parsed instead.
    const body = hasProtoKey(compact)
      ? `JSON.parse(${jsString(compact)})`
      : bodyJson(spec.body.value, { space: 2, placeholderLiteral });
    lines.push(`const { response } = await dataApi<${responseType}>(${call}, ${body});`);
  } else {
    lines.push(`const { response } = await dataApi<${responseType}>(${call});`);
  }

  lines.push('console.log(response);');
  return lines.join('\n');
}
