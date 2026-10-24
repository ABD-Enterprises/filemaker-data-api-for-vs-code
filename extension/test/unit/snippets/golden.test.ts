import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { describe, expect, it } from 'vitest';

import { generateSnippet, SnippetError, type SnippetFormat } from '../../../src/snippets';
import { req } from './checks';
import { directProfile, EXTENSION, FORMATS, OPERATIONS, proxyProfile } from './fixtures';

const GOLDEN = join(__dirname, '..', '..', 'fixtures', 'snippets', 'golden');
const update = process.env.UPDATE_GOLDEN === '1';

function check(name: string, text: string): void {
  const path = join(GOLDEN, name);
  if (update) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
    return;
  }
  expect(existsSync(path), `${name} is missing: run UPDATE_GOLDEN=1 npx vitest run test/unit/snippets/golden.test.ts`).toBe(true);
  expect(text).toBe(readFileSync(path, 'utf8'));
}

function render(profile: typeof directProfile, operationName: string, format: SnippetFormat, includeAuthHeader: boolean): string {
  return generateSnippet(profile, req(OPERATIONS[operationName]), format, { includeAuthHeader });
}

describe('golden files: every operation in every format', () => {
  for (const operationName of Object.keys(OPERATIONS)) {
    for (const format of FORMATS) {
      it(`direct profile, ${operationName}, ${format}`, () => {
        if (operationName === 'runScriptLongParam') {
          expect(() => render(directProfile, operationName, format, false)).toThrow(/too long/);
          return;
        }
        check(`direct/${operationName}.${format}.${EXTENSION[format]}`, render(directProfile, operationName, format, false));
      });
    }
  }

  for (const operationName of ['login', 'find', 'editRecord', 'runScript', 'deleteRecord', 'uploadContainerModId']) {
    for (const format of FORMATS) {
      it(`direct profile with the auth opt-in, ${operationName}, ${format}`, () => {
        check(`direct-auth/${operationName}.${format}.${EXTENSION[format]}`, render(directProfile, operationName, format, true));
      });
    }
  }

  for (const operationName of ['login', 'find', 'editRecord', 'runScript', 'uploadContainerModId']) {
    for (const format of FORMATS) {
      it(`proxy profile, ${operationName}, ${format}`, () => {
        check(`proxy/${operationName}.${format}.${EXTENSION[format]}`, render(proxyProfile, operationName, format, false));
        check(`proxy-auth/${operationName}.${format}.${EXTENSION[format]}`, render(proxyProfile, operationName, format, true));
      });
    }
  }

  it('refuses a script parameter that cannot fit in a web address when a record is in context', () => {
    expect(() =>
      generateSnippet(directProfile, { kind: 'runScript', layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(2100), recordId: '1' }, 'curl')
    ).toThrow(SnippetError);
  });
});
