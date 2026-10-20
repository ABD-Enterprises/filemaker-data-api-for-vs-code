import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps the release instructions intact and the Layout Mode feature under Features of 1.6.0', () => {
  const root = readFileSync(resolve(__dirname, '../../../CHANGELOG.md'), 'utf8');
  expect(root).toContain('labels, or\napplies the `changelog-skip` label');
  // The Layout Mode feature shipped in 1.6.0, so it sits under that release (the section after Unreleased).
  expect(
    root.split('\n## 1.6.0 - ')[1]?.split('### [FEATURE]')[1]?.split('### [FIX]')[0]
  ).toContain('- Layout Mode adds standard field sizes');
  const extension = readFileSync(resolve(__dirname, '../../CHANGELOG.md'), 'utf8');
  // A fresh, empty Unreleased section sits above the release so the next change has a place to go.
  expect(extension).toMatch(/^# Changelog\n\n## Unreleased\n\n## 1\.6\.0\n/);
  expect(extension.split('\n## 1.6.0\n')[1]?.split('\n## ')[0]).toContain('Layout Mode');
});
