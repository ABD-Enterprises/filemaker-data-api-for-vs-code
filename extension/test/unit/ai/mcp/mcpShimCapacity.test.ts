import { readFileSync } from 'fs';
import { join } from 'path';
import { stripTypeScriptTypes } from 'module';
import { afterEach, expect, it, vi } from 'vitest';

// Execute the real test body with delayed child processes. This also catches a return to fixed sleeps.
it('the shim-capacity assertion waits for a slow Windows startup', async () => {
  vi.useFakeTimers();
  const source = readFileSync(join(__dirname, 'mcpEndToEnd.test.ts'), 'utf8');
  const start = source.indexOf("it('accepts only maxConnections shims at once");
  const bodyStart = source.indexOf('async () => {', start) + 'async () => {'.length;
  const end = source.indexOf('\n  it(', bodyStart);
  const body = source.slice(bodyStart, source.lastIndexOf('\n  }', end));
  let authenticated = 0;
  const children: Array<{ exitCode: number | null }> = [];
  const spawn = () => {
    const child = { exitCode: null as number | null };
    const number = children.length;
    setTimeout(() => { if (number < 3) authenticated += 1; else child.exitCode = 1; }, 6000);
    return child;
  };
  const run = new Function('openWindow', 'join', 'work', 'spawn', 'process', 'shimPath', 'children', 'expect',
    `${stripTypeScriptTypes(`async function execute() { ${body} }`)}; return execute();`) as (...args: unknown[]) => Promise<void>;
  let done = false;
  const outcome = run(async () => ({ directory: 'x', server: { connectionCount: () => authenticated } }), join, '/work', spawn,
    { execPath: '/node' }, '/shim', children, expect).then(() => { done = true; return undefined; }, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2200);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(7000);
  expect(await outcome).toBeUndefined();
  expect(done).toBe(true);
});
afterEach(() => vi.useRealTimers());
