import { existsSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { generateSnippet } from '../../../src/snippets';
import { redactValue } from '../../../src/utils/redact';
import { cleanupScratch, roundTrip, scratch } from './checks';
import { directProfile, hostileOperations, hostileStrings } from './fixtures';

afterAll(cleanupScratch);

// The shell round trip needs a POSIX shell (the round trip of the other formats rides along with it).
describe.skipIf(process.platform === 'win32')('hostile layout, field, script and record names and values', () => {
  const pwn = join(scratch(), 'pwned');
  const strings = hostileStrings(pwn);

  it('the corpus itself is untouched by the redaction helpers (so a change in a result is the code under test)', () => {
    for (const [name, value] of Object.entries(strings)) {
      expect(redactValue({ [value]: value }), name).toEqual({ [value]: value });
    }
  });

  for (const [name, value] of Object.entries(strings)) {
    for (const includeAuth of [false, true]) {
      it(`${name}: every format reads back as the intended request (auth opt-in ${includeAuth ? 'on' : 'off'})`, async () => {
        for (const [operationName, operation] of Object.entries(hostileOperations(value))) {
          const results = await roundTrip(generateSnippet, directProfile, operation, { includeAuth, pwnFile: pwn });
          for (const result of results) {
            expect(result.problems, `${operationName} as ${result.format}`).toEqual([]);
          }
        }
        expect(existsSync(pwn)).toBe(false);
      });
    }
  }
});
