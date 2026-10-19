import { jsString, prefixedLines, safeJson } from './escape';
import type { RequestSpec, SnippetOptions } from './model';
import { bodyJson, pathAndQuery } from './render';

const STYLE = { modId: '<modId>' };

export function renderFetch(spec: RequestSpec, options: SnippetOptions = {}): string {
  const lines: string[] = spec.notes.flatMap((note) => prefixedLines('// ', note));
  const headers: string[] = [];
  const url = jsString(`${spec.host}${pathAndQuery(spec, STYLE)}`);

  if (spec.body?.kind === 'upload') {
    lines.push('import { readFile } from "node:fs/promises";', '');
  }

  if (spec.auth === 'basic') {
    lines.push(
      'const basic = Buffer.from(`${process.env.FM_USERNAME ?? "<account name>"}:${process.env.FM_PASSWORD ?? "<password>"}`).toString("base64");'
    );
    headers.push('"Authorization": `Basic ${basic}`');
  } else if (options.includeAuthHeader) {
    const variable = spec.auth === 'proxy' ? 'FM_PROXY_API_KEY' : 'FM_TOKEN';
    const fallback = spec.auth === 'proxy' ? '<proxy api key>' : '<session token>';
    lines.push(`const token = process.env.${variable} ?? ${jsString(fallback)};`);
    headers.push('"Authorization": `Bearer ${token}`');
  } else {
    headers.push(`"Authorization": ${jsString('Bearer <REDACTED>')}`);
  }

  let bodyLine: string | undefined;
  if (spec.body?.kind === 'json') {
    headers.unshift('"Content-Type": "application/json"');
    const text = bodyJson(spec.body.value, { placeholderLiteral: (name) => safeJson(`<${name}>`) });
    bodyLine = `  body: ${jsString(text)},`;
  } else if (spec.body?.kind === 'upload') {
    lines.push(
      'const form = new FormData();',
      'form.append("upload", new Blob([await readFile("./file-to-upload")]), "file-to-upload");'
    );
    bodyLine = '  body: form,';
  }

  lines.push(`const response = await fetch(${url}, {`);
  lines.push(`  method: ${jsString(spec.method)},`);
  lines.push('  headers: {');
  lines.push(...headers.map((header, index) => `    ${header}${index < headers.length - 1 ? ',' : ''}`));
  lines.push('  },');
  if (bodyLine) {
    lines.push(bodyLine);
  }
  lines.push('});', 'const data = await response.json();');
  return lines.join('\n');
}
