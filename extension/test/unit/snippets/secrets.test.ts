import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { generateSnippet, SnippetError } from '../../../src/snippets';
import { req } from './checks';
import { FORMATS } from './fixtures';
import { leakyDirect, leakyOperations, leakyProxy, SENTINELS } from './leaky';

describe('secrets never reach a copied request', () => {
  for (const [profileName, profile] of [['direct', leakyDirect], ['proxy', leakyProxy]] as const) {
    for (const format of FORMATS) {
      for (const includeAuthHeader of [false, true]) {
        it(`${profileName} profile, ${format}, auth opt-in ${includeAuthHeader ? 'on' : 'off'}: no password, token, API key, account or query secret`, () => {
          for (const operation of leakyOperations) {
            const text = generateSnippet(profile, operation, format, { includeAuthHeader });
            for (const [name, sentinel] of Object.entries(SENTINELS)) {
              expect(text.includes(sentinel), `${operation.kind} leaked ${name}`).toBe(false);
              expect(text.includes(encodeURIComponent(sentinel)), `${operation.kind} leaked ${name} (encoded)`).toBe(false);
            }
          }
        });
      }
    }
  }

  it('the server address keeps its host, port and path prefix and loses the account, query and fragment', () => {
    const text = generateSnippet(leakyDirect, { kind: 'listLayouts' }, 'curl');
    expect(text).toContain("'https://fm.example.com:8443/prefix/fmi/data/vLatest/databases/Sales/layouts'");
  });

  it('says so when text that looked like a credential was replaced', () => {
    const text = generateSnippet(leakyDirect, req(leakyOperations[3]), 'curl');
    expect(text).toContain('# Some text looked like a credential and was replaced with ***');
    expect(text).toContain('***');
  });

  it('an address that is not a web address is refused without echoing a secret from it', () => {
    const bad = { ...leakyDirect, serverUrl: `not a url ${SENTINELS.password}@x password=${SENTINELS.password}` };
    let message = '';
    try {
      generateSnippet(bad, { kind: 'listLayouts' }, 'curl');
    } catch (error) {
      expect(error).toBeInstanceOf(SnippetError);
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(SENTINELS.password);
    expect(() => generateSnippet({ ...leakyDirect, serverUrl: 'ftp://fm.example.com' }, { kind: 'listLayouts' }, 'curl')).toThrow(SnippetError);
  });

  it('the Authorization header only ever carries a placeholder', () => {
    const placeholder = /(Bearer|Basic) (<REDACTED>|\*\*\*|\$FM_TOKEN|\$FM_PROXY_API_KEY|\{\{(token|proxyApiKey|username)\}\}|\$\{(token|basic)\})/;
    for (const format of FORMATS) {
      for (const includeAuthHeader of [false, true]) {
        for (const operation of leakyOperations) {
          const text = generateSnippet(leakyDirect, operation, format, { includeAuthHeader });
          const lines = text.split('\n').filter((line) => /authorization/i.test(line) && /(Bearer|Basic)/.test(line));
          for (const line of lines) {
            expect(line, `${format} ${operation.kind}`).toMatch(placeholder);
          }
        }
      }
    }
  });

  it('the snippet code never reads the secret store, the session or the profile password', () => {
    const files = [
      ...readdirSync(join(__dirname, '..', '..', '..', 'src', 'snippets')).map((name) => join(__dirname, '..', '..', '..', 'src', 'snippets', name)),
      join(__dirname, '..', '..', '..', 'src', 'commands', 'copyRequest.ts')
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/secretStore|getPassword|getSessionToken|getProxyApiKey|ensureSessionToken|createSession\(/i);
    }
  });
});
