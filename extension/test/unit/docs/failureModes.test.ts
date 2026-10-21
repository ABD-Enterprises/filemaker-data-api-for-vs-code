import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');

it('every backtick file reference in the failure-mode catalogue exists', () => {
  const document = readFileSync(path.join(root, 'docs/FILEMAKER_FAILURE_MODES.md'), 'utf8');
  const paths = Array.from(document.matchAll(/`([^`\n]+)`/g), (match) => match[1]!)
    .filter((value) => !value.includes('://'))
    .map((value) => /^([\w./-]+\.(?:ts|js|mjs|md|json|css|html|txt))(?::[\d, -]+)?$/.exec(value)?.[1])
    .filter((value): value is string => value !== undefined);
  expect(paths.length).toBeGreaterThan(0);
  for (const file of new Set(paths)) {
    // Older certificate rows retain extension/src-relative and short service / utility paths.
    const bases = ['', 'extension/src', 'extension/src/services', 'extension/src/utils', 'extension/src/webviews', 'extension'];
    expect(bases.some((base) => existsSync(path.join(root, base, file))), file).toBe(true);
  }
});
