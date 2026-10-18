import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// The data hook and the layout page read their settings from Next.js `process.env.NEXT_PUBLIC_*`
// references, which Next replaces at build time only when written out literally, so they cannot
// be exercised by calling them here. These checks pin the wiring in the source instead.
const read = (...parts: string[]): string => readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8');

describe('bridge token wiring', () => {
  it('useRuntimeDataController gives the client the URL and the token', () => {
    const source = read('lib', 'runtime-data.ts');
    const call = /new RuntimeBridgeClient\(([\s\S]*?)\)\s*,\s*\[\]/.exec(source)?.[1] ?? '';
    expect(call).toContain('process.env.NEXT_PUBLIC_FMWEB_BRIDGE_URL');
    expect(call).toContain('process.env.NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN');
    expect(call.indexOf('BRIDGE_URL')).toBeLessThan(call.indexOf('BRIDGE_TOKEN'));
  });

  it('the layout page passes the token to behavior actions', () => {
    const source = read('app', 'layouts', '[id]', 'runtime-layout-client.tsx');
    expect(source).toMatch(/bridgeToken:\s*process\.env\.NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN/);
  });

  it('runtime-behavior hands the token to the client', () => {
    expect(read('lib', 'runtime-behavior.ts')).toMatch(
      /new RuntimeBridgeClient\(context\.bridgeBaseUrl,\s*context\.fetchFn,\s*context\.bridgeToken\)/
    );
  });

  it('every managed file carries the template version marker', () => {
    for (const file of [
      ['lib', 'bridge-client.ts'],
      ['lib', 'runtime-data.ts'],
      ['lib', 'runtime-behavior.ts'],
      ['app', 'layouts', '[id]', 'runtime-layout-client.tsx']
    ]) {
      expect(read(...file).split('\n', 1)[0], file.join('/')).toMatch(/^\/\/ fmweb-managed: runtime template v\d+/);
    }
  });
});
