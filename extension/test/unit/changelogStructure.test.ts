import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps the release instructions intact and the Layout Mode feature under Features', () => {
  const root = readFileSync(resolve(__dirname, '../../../CHANGELOG.md'), 'utf8');
  expect(root).toContain('labels, or\napplies the `changelog-skip` label');
  expect(root.split('\n## Unreleased\n')[1]?.split('### [FEATURE]')[1]?.split('### [FIX]')[0]).toContain('- [FEATURE] Layout Mode');
  const extension = readFileSync(resolve(__dirname, '../../CHANGELOG.md'), 'utf8');
  expect(extension).toMatch(/## Unreleased[\s\S]*Layout Mode/);
});
