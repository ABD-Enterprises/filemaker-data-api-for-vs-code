import { spawnSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { bashSyntaxProblems, cleanupScratch, runScriptSnippet, transpile, typeErrors } from './checks';

/** Reads every golden file with the tools that will receive it. Shell and compiler checks need a POSIX machine. */
const GOLDEN = join(__dirname, '..', '..', 'fixtures', 'snippets', 'golden');
const posix = process.platform !== 'win32';

function goldenFiles(suffix: string): Array<{ name: string; text: string }> {
  const files: Array<{ name: string; text: string }> = [];
  for (const directory of readdirSync(GOLDEN)) {
    for (const file of readdirSync(join(GOLDEN, directory))) {
      if (file.endsWith(suffix)) {
        files.push({ name: `${directory}/${file}`, text: readFileSync(join(GOLDEN, directory, file), 'utf8') });
      }
    }
  }
  return files;
}

const hasShellcheck = posix && spawnSync('shellcheck', ['--version']).status === 0;
const hasZsh = posix && spawnSync('zsh', ['--version']).status === 0;

afterAll(cleanupScratch);

describe.skipIf(!posix)('curl commands', () => {
  const scripts = goldenFiles('.curl.sh');

  it('there is one for every golden case', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(30);
  });

  it('parse as bash, as POSIX sh and as zsh', () => {
    for (const script of scripts) {
      expect(bashSyntaxProblems(script.text, 'bash'), script.name).toEqual([]);
      expect(bashSyntaxProblems(script.text, 'sh'), script.name).toEqual([]);
      if (hasZsh) {
        expect(bashSyntaxProblems(script.text, 'zsh'), script.name).toEqual([]);
      }
    }
  });

  it.skipIf(!hasShellcheck)('pass shellcheck with no finding', () => {
    for (const script of scripts) {
      const dir = join(__dirname, '..', '..', 'fixtures', 'snippets', 'golden');
      const file = join(dir, script.name);
      const result = spawnSync('shellcheck', ['--shell=sh', '--severity=style', file], { encoding: 'utf8' });
      expect(`${script.name}\n${result.stdout}`, `${script.name}\n${result.stdout}`).toBe(`${script.name}\n`);
    }
  });
});

describe('fetch() snippets', () => {
  it('run, send exactly one request and parse their own body', async () => {
    const files = goldenFiles('.fetch.js');
    expect(files.length).toBeGreaterThanOrEqual(30);
    for (const file of files) {
      const { wire } = await runScriptSnippet(file.text, { FM_TOKEN: 'TESTTOKEN', FM_USERNAME: 'u', FM_PASSWORD: 'p', FM_PROXY_API_KEY: 'k' });
      expect(wire.method, file.name).toMatch(/^(GET|POST|PATCH|DELETE)$/);
      expect(wire.url, file.name).toMatch(/^https:\/\//);
      if (wire.body !== undefined && wire.body !== '<multipart>') {
        expect(() => JSON.parse(wire.body as string), file.name).not.toThrow();
      }
    }
  });
});

describe.skipIf(!posix)('TypeScript snippets', () => {
  const files = goldenFiles('.typescript.ts.txt');

  it('compile in strict mode against the DOM and Node typings', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
    const errors = typeErrors(Object.fromEntries(files.map((file) => [file.name, file.text])));
    for (const [name, list] of Object.entries(errors)) {
      expect(list, name).toEqual([]);
    }
  });

  it('run, send exactly one request and parse their own body', async () => {
    for (const file of files) {
      const { wire } = await runScriptSnippet(transpile(file.text), { FM_TOKEN: 'TESTTOKEN', FM_USERNAME: 'u', FM_PASSWORD: 'p', FM_PROXY_API_KEY: 'k' });
      expect(wire.method, file.name).toMatch(/^(GET|POST|PATCH|DELETE)$/);
      if (wire.method === 'GET' || wire.method === 'DELETE') {
        expect(wire.headers.map(([name]) => name), file.name).not.toContain('Content-Type');
      }
      if (wire.body !== undefined && wire.body !== '<multipart>') {
        expect(() => JSON.parse(wire.body as string), file.name).not.toThrow();
      }
    }
  });
});

describe('.http and Postman files', () => {
  it('end with a line feed, contain no carriage return and exactly one request', () => {
    for (const file of goldenFiles('.http.http')) {
      expect(file.text.endsWith('\n'), file.name).toBe(true);
      expect(file.text.includes('\r'), file.name).toBe(false);
      expect(file.text.split('\n').filter((line) => line.startsWith('###')), file.name).toHaveLength(1);
    }
  });

  it('Postman files are v2.1 collections with one request and the variables they use', () => {
    for (const file of goldenFiles('.postman.json')) {
      const collection = JSON.parse(file.text) as {
        info: { schema: string };
        item: unknown[];
        variable: Array<{ key: string; value: string }>;
      };
      expect(collection.info.schema, file.name).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
      expect(collection.item, file.name).toHaveLength(1);
      const keys = collection.variable.map((entry) => entry.key);
      expect(keys, file.name).toContain('baseUrl');
      // Only the base URL has a value: everything the reader must supply starts empty.
      for (const entry of collection.variable) {
        if (entry.key !== 'baseUrl') {
          expect(entry.value, `${file.name} ${entry.key}`).toBe('');
        }
      }
      for (const used of file.text.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(keys, `${file.name} uses {{${used[1]}}}`).toContain(used[1]);
      }
    }
  });
});
