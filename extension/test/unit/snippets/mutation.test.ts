import { join } from 'path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupScratch, req, roundTrip, scratch, type Generate } from './checks';
import { directProfile, hostileOperations, hostileStrings } from './fixtures';
import { leakyDirect, leakyOperations, leakyProxy, SENTINELS } from './leaky';

/**
 * Mutation checks. The hostile round trips and the secret scan are only worth something if they
 * fail when an escape or a placeholder rule is weakened. Each mutant below replaces one rule with the
 * mistake a quick implementation would make, and the checks must notice.
 */

type Mutant = { name: string; module: string; overrides: (original: Record<string, unknown>) => Record<string, unknown> };

const ESCAPE = '../../../src/snippets/escape';

const MUTANTS: Mutant[] = [
  {
    name: 'shell quoting that does not handle a single quote',
    module: ESCAPE,
    overrides: () => ({ shellQuote: (value: string) => `'${value}'` })
  },
  {
    name: 'shell quoting with double quotes',
    module: ESCAPE,
    overrides: () => ({ shellQuote: (value: string) => `"${value}"` })
  },
  {
    name: 'JSON and JavaScript strings without the U+2028 and </script escapes',
    module: ESCAPE,
    overrides: () => ({
      safeJson: (value: unknown, options: { space?: number } = {}) => JSON.stringify(value, null, options.space),
      jsString: (value: string) => JSON.stringify(value)
    })
  },
  {
    name: 'a body that lets REST Client and Postman expand {{variables}}',
    module: ESCAPE,
    overrides: (original) => ({
      safeJson: (value: unknown, options: { space?: number; neutralizeTemplates?: boolean } = {}) =>
        (original.safeJson as (v: unknown, o: unknown) => string)(value, { space: options.space })
    })
  },
  {
    name: 'titles that keep line breaks',
    module: ESCAPE,
    overrides: () => ({ singleLine: (value: string) => value })
  },
  {
    name: 'path segments that are not percent-encoded like the client does',
    module: ESCAPE,
    overrides: () => ({ encodeComponent: (value: string) => encodeURI(value) })
  },
  {
    name: 'no redaction of copied text',
    module: '../../../src/utils/redact',
    overrides: () => ({ redactString: (value: string) => value, redactValue: (value: unknown) => value })
  },
  {
    name: 'a server address that keeps its account, query and fragment',
    module: '../../../src/snippets/address',
    overrides: () => ({ cleanServerAddress: (address: string) => address })
  }
];

/** True when the round trips or the secret scan notice a problem with `generate`. */
async function detects(generate: Generate): Promise<boolean> {
  const pwn = join(scratch(), 'pwned-mutation');
  const strings = hostileStrings(pwn);
  const operationNames = ['find', 'getRecord', 'editRecord', 'runScript', 'runScriptWithRecord'];

  for (const value of Object.values(strings)) {
    const operations = hostileOperations(value);
    for (const name of operationNames) {
      try {
        const results = await roundTrip(generate, directProfile, req(operations[name]), { includeAuth: false, pwnFile: pwn });
        if (results.some((result) => result.problems.length > 0)) {
          return true;
        }
      } catch {
        return true;
      }
    }
  }

  for (const profile of [leakyDirect, leakyProxy]) {
    for (const operation of leakyOperations) {
      for (const format of ['curl', 'fetch', 'http', 'postman', 'typescript'] as const) {
        let text: string;
        try {
          text = generate(profile, operation, format, { includeAuthHeader: true });
        } catch {
          return true;
        }
        if (Object.values(SENTINELS).some((sentinel) => text.includes(sentinel))) {
          return true;
        }
      }
    }
  }
  return false;
}

async function loadWith(mutant?: Mutant): Promise<Generate> {
  vi.resetModules();
  vi.doUnmock(ESCAPE);
  vi.doUnmock('../../../src/utils/redact');
  vi.doUnmock('../../../src/snippets/address');
  if (mutant) {
    const original = await vi.importActual<Record<string, unknown>>(mutant.module);
    vi.doMock(mutant.module, () => ({ ...original, ...mutant.overrides(original) }));
  }
  const module = await import('../../../src/snippets');
  return module.generateSnippet as Generate;
}

afterEach(() => {
  vi.doUnmock(ESCAPE);
  vi.doUnmock('../../../src/utils/redact');
  vi.doUnmock('../../../src/snippets/address');
  vi.resetModules();
});
afterAll(cleanupScratch);

describe.skipIf(process.platform === 'win32')('mutations of the escaping and placeholder rules are caught', () => {
  // The control is the only case that runs every hostile string through every operation, and each
  // round trip starts three child processes (bash -n, sh -n, and the run itself): 225 process
  // starts in one test. That measured 10.6 s on an otherwise idle machine and 14.7 s on a loaded
  // one, so it never fits vitest's 5 s default. The budget is 60 s, about four times the slowest
  // measurement, and the check itself is unchanged.
  it('control: the real implementation passes every check', async () => {
    expect(await detects(await loadWith())).toBe(false);
  }, 60_000);

  for (const mutant of MUTANTS) {
    it(`mutant: ${mutant.name}`, async () => {
      expect(await detects(await loadWith(mutant))).toBe(true);
    });
  }
});
