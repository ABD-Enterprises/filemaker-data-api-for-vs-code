import { safeJson, singleLine } from './escape';
import type { RequestSpec, SnippetOptions } from './model';
import { bodyJson, queryText, usesModId } from './render';

const STYLE = { modId: '{{modId}}' };
export const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

interface PostmanVariable {
  key: string;
  value: string;
  description?: string;
}

/** The collection as an object (exported so tests can read it back). */
export function buildPostmanCollection(spec: RequestSpec, options: SnippetOptions = {}): Record<string, unknown> {
  const variables: PostmanVariable[] = [
    { key: 'baseUrl', value: spec.host, description: 'The server address of the connection profile.' }
  ];
  const header: Array<{ key: string; value: string; type: 'text' }> = [];
  let auth: Record<string, unknown> | undefined;

  if (spec.auth === 'basic') {
    variables.push(
      { key: 'username', value: '', description: 'FileMaker account name (fill in; never copied).' },
      { key: 'password', value: '', description: 'FileMaker account password (fill in; never copied).' }
    );
    auth = {
      type: 'basic',
      basic: [
        { key: 'username', value: '{{username}}', type: 'string' },
        { key: 'password', value: '{{password}}', type: 'string' }
      ]
    };
  } else if (options.includeAuthHeader) {
    if (spec.auth === 'proxy') {
      variables.push({ key: 'proxyApiKey', value: '', description: 'Proxy API key (fill in; never copied).' });
      header.push({ key: 'Authorization', value: 'Bearer {{proxyApiKey}}', type: 'text' });
    } else {
      variables.push({ key: 'token', value: '', description: 'Session token from the login request (fill in; never copied).' });
      header.push({ key: 'Authorization', value: 'Bearer {{token}}', type: 'text' });
    }
  } else {
    header.push({ key: 'Authorization', value: 'Bearer <REDACTED>', type: 'text' });
  }
  if (usesModId(spec)) {
    variables.push({ key: 'modId', value: '', description: 'The modId of the record you read (fill in).' });
  }

  // The URL is one string, with the query percent-encoded in it. The structured form (a `query` array
  // of raw values) would let Postman expand a `{{variable}}` that came from the database.
  const query = queryText(spec, STYLE);
  const request: Record<string, unknown> = {
    method: spec.method,
    header,
    url: `{{baseUrl}}${spec.path}${query.length > 0 ? `?${query}` : ''}`
  };
  if (auth) {
    request.auth = auth;
  }
  if (spec.notes.length > 0) {
    request.description = spec.notes.map((note) => singleLine(note)).join('\n');
  }

  if (spec.body?.kind === 'json') {
    header.unshift({ key: 'Content-Type', value: 'application/json', type: 'text' });
    request.body = {
      mode: 'raw',
      raw: bodyJson(spec.body.value, {
        space: 2,
        neutralizeTemplates: true,
        placeholderLiteral: () => '"{{modId}}"'
      }),
      options: { raw: { language: 'json' } }
    };
  } else if (spec.body?.kind === 'upload') {
    request.body = { mode: 'formdata', formdata: [{ key: 'upload', type: 'file', src: './file-to-upload' }] };
  }

  const title = singleLine(spec.title);
  return {
    info: { name: title, schema: POSTMAN_SCHEMA },
    item: [{ name: title, request }],
    variable: variables
  };
}

export function renderPostman(spec: RequestSpec, options: SnippetOptions = {}): string {
  return `${safeJson(buildPostmanCollection(spec, options), { space: 2 })}\n`;
}
