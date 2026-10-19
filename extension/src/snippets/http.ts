import { prefixedLines, singleLine } from './escape';
import type { RequestSpec, SnippetOptions } from './model';
import { bodyJson, pathAndQuery, usesModId } from './render';

const STYLE = { modId: '{{modId}}' };
const BOUNDARY = 'FileMakerUploadBoundary';

/**
 * A `.http` file for VS Code's REST Client (the built-in HTTP file convention: `@variable = value`,
 * `{{variable}}`, requests separated by `###`). Lines end with LF only: nothing the database sent can
 * contain a CR or LF here, so it cannot add a header or start a second request.
 */
export function renderHttp(spec: RequestSpec, options: SnippetOptions = {}): string {
  const lines: string[] = [];
  for (const note of spec.notes) {
    lines.push(...prefixedLines('# ', note));
  }
  lines.push(`@host = ${spec.host}`);

  const headers: string[] = [];
  if (spec.auth === 'basic') {
    lines.push('@username = <account name>', '@password = <password>');
    headers.push('Authorization: Basic {{username}}:{{password}}');
  } else if (options.includeAuthHeader) {
    if (spec.auth === 'proxy') {
      lines.push('@proxyApiKey = <proxy api key>');
      headers.push('Authorization: Bearer {{proxyApiKey}}');
    } else {
      lines.push('@token = <session token>');
      headers.push('Authorization: Bearer {{token}}');
    }
  } else {
    headers.push('Authorization: Bearer <REDACTED>');
  }
  if (usesModId(spec)) {
    lines.push('@modId = <modId>');
  }

  lines.push('', `### ${singleLine(spec.title)}`);
  lines.push(`${spec.method} {{host}}${pathAndQuery(spec, STYLE)}`);

  if (spec.body?.kind === 'json') {
    headers.unshift('Content-Type: application/json');
  } else if (spec.body?.kind === 'upload') {
    headers.unshift(`Content-Type: multipart/form-data; boundary=${BOUNDARY}`);
  }
  lines.push(...headers);

  if (spec.body?.kind === 'json') {
    lines.push(
      '',
      bodyJson(spec.body.value, {
        space: 2,
        neutralizeTemplates: true,
        placeholderLiteral: () => '"{{modId}}"'
      })
    );
  } else if (spec.body?.kind === 'upload') {
    lines.push(
      '',
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="upload"; filename="file-to-upload"',
      'Content-Type: application/octet-stream',
      '',
      '< ./file-to-upload',
      `--${BOUNDARY}--`
    );
  }
  return `${lines.join('\n')}\n`;
}
