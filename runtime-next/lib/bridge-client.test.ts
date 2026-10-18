import { describe, expect, it, vi } from 'vitest';

import { RuntimeBridgeClient } from './bridge-client';

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"data":[]}', { status: 200 }));
}

describe('RuntimeBridgeClient', () => {
  it('sends the bridge token header on every request when a token is configured', async () => {
    const fetchFn = okFetch();
    const client = new RuntimeBridgeClient('http://127.0.0.1:1/fm/', fetchFn as never, 'secret-token');
    await client.find({ layout: 'L', query: [{}] });
    await client.getRecord('L', '1');
    for (const [, init] of fetchFn.mock.calls) {
      expect((init?.headers as Record<string, string>)['X-FM-Bridge-Token']).toBe('secret-token');
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('sends no token header when none is configured', async () => {
    const fetchFn = okFetch();
    await new RuntimeBridgeClient('http://127.0.0.1:1/fm', fetchFn as never).find({ layout: 'L', query: [{}] });
    expect(Object.keys((fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>) ?? {})).not.toContain(
      'X-FM-Bridge-Token'
    );
  });
});
