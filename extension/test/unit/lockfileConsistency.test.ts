import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';

it('locks the exact why-is-node-running version Vitest requires', () => {
  const lock = JSON.parse(readFileSync(join(__dirname, '../../../package-lock.json'), 'utf8')) as {
    packages: Record<string, { version: string; resolved: string; integrity: string; dependencies?: Record<string, string> }>;
  };
  const required = lock.packages['node_modules/vitest']?.dependencies?.['why-is-node-running'];
  const dependency = lock.packages['node_modules/vitest/node_modules/why-is-node-running'];
  expect(required).toBeDefined();
  expect(dependency?.version).toBe(required);
  expect(dependency?.resolved).toContain(`why-is-node-running-${required}.tgz`);
  expect(dependency?.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
});
