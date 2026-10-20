import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps the release instructions intact and the Layout Mode feature under Features of 1.6.0', () => {
  const root = readFileSync(resolve(__dirname, '../../../CHANGELOG.md'), 'utf8');
  expect(root).toContain('labels, or\napplies the `changelog-skip` label');
  // The Layout Mode feature shipped in 1.6.0, so it sits under that release (the section after Unreleased).
  expect(root.split('\n## 1.6.0 - ')[1]?.split('### [FEATURE]')[1]?.split('### [FIX]')[0]).toContain('- [FEATURE] Layout Mode');
  const extension = readFileSync(resolve(__dirname, '../../CHANGELOG.md'), 'utf8');
  expect(extension).toMatch(/## 1\.6\.0[\s\S]*Layout Mode/);
});
