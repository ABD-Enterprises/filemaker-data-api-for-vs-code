import { readFileSync } from 'fs';
import { resolve } from 'path';
import { expect, it } from 'vitest';

it('describes Server support and clearly says Claris ID Cloud sign-in is unsupported', () => {
  const { description } = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { description: string };
  expect(description).toContain('for Claris FileMaker Server.');
  expect(description).toContain('FileMaker Cloud sign-in with a Claris ID is not supported yet.');
  expect(description).not.toMatch(/Server and FileMaker Cloud/);
});
