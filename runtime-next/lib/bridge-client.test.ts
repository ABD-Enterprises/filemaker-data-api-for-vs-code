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

describe('FileMaker record version and empty data', () => {
  it('includes modId in the edit request and explains FileMaker 306', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ error: 'Record modification ID does not match.', code: '306' }), { status: 500 }));
    const client = new RuntimeBridgeClient('http://bridge.test/fm', fetchFn, 'token');
    await expect(client.editRecord(' Layout ', '19', { ' Field ': 'value' }, '7')).rejects.toThrow(/changed.*306/);
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({ layout: ' Layout ', recordId: '19', fieldData: { ' Field ': 'value' }, modId: '7' });
  });
  it('treats no-record error 401 as an empty found set', async () => {
    const client = new RuntimeBridgeClient('http://bridge.test/fm', async () => new Response(JSON.stringify({ error: 'No records match', code: '401' }), { status: 500 }));
    expect(await client.find({ layout: 'Empty', query: [{}] })).toEqual({ data: [] });
  });
});
