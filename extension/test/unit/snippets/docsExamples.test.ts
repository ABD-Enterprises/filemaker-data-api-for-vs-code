import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { generateSnippet } from '../../../src/snippets';
import { directProfile } from './fixtures';

/** The examples in the user guide are the real output, not a sketch of it. */
const guide = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'USER_GUIDE.md'), 'utf8');
const section = guide.slice(guide.indexOf('## Copy a request as code'), guide.indexOf('## Schema snapshots and diffs'));

function fenced(language: string): string {
  const match = new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```').exec(section);
  if (!match?.[1]) {
    throw new Error(`no ${language} example in the guide`);
  }
  return match[1];
}

const profile = { ...directProfile, database: 'Sales' };
const operation = { kind: 'find', layout: 'Contacts', request: { query: [{ City: 'Portland' }], limit: 25 } } as const;

describe('user guide: Copy a request as code', () => {
  it('the .http example is what the extension copies', () => {
    expect(`${fenced('http')}\n`).toBe(generateSnippet(profile, { ...operation, request: { ...operation.request, query: [{ City: 'Portland' }] } }, 'http', { includeAuthHeader: true }));
  });

  it('the curl example is what the extension copies', () => {
    expect(fenced('sh')).toBe(generateSnippet(profile, { ...operation, request: { ...operation.request, query: [{ City: 'Portland' }] } }, 'curl', { includeAuthHeader: true }));
  });

  it('names every format, every place and the never-copied secrets', () => {
    for (const text of ['curl', 'fetch()', '.http (REST Client)', 'Postman collection', 'TypeScript', 'Save as .http file…', 'Copy request for this record', 'FileMaker: Copy Request as Code…', 'password, the session token and the API key']) {
      expect(section, text).toContain(text);
    }
  });
});
