import { describe, expect, it } from 'vitest';

import { NetworkLogStore } from '../../src/diagnostics/networkLogStore';

describe('NetworkLogStore', () => {
  it('redacts authorization headers and secret-like payload values', async () => {
    const store = new NetworkLogStore({
      now: () => new Date('2026-05-24T12:00:00.000Z')
    });

    await store.record({
      requestId: 'req-1',
      method: 'POST',
      url: 'https://fm.example.com/fmi/data/vLatest/databases/DB/sessions',
      relativeUrl: '/fmi/data/vLatest/databases/DB/sessions',
      requestHeaders: {
        Authorization: 'Basic username-password',
        Accept: 'application/json'
      },
      requestBody: {
        password: 'secret',
        fieldData: {
          Name: 'Ada'
        }
      },
      responseStatus: 200,
      responseHeaders: {
        'set-cookie': 'session=secret'
      },
      responseBody: {
        response: {
          token: 'session-token',
          ok: true
        }
      },
      durationMs: 12
    });

    const entry = store.listEntries()[0];
    expect(entry?.timestamp).toBe('2026-05-24T12:00:00.000Z');
    expect(entry?.requestHeaders.Authorization).toBe('***');
    expect(entry?.requestHeaders.Accept).toBe('application/json');
    expect(entry?.requestBody).toMatchObject({
      password: '***',
      fieldData: {
        Name: 'Ada'
      }
    });
    expect(entry?.responseHeaders['set-cookie']).toBe('***');
    expect(entry?.responseBody).toMatchObject({
      response: {
        token: '***',
        ok: true
      }
    });
  });

  it('keeps a bounded newest-first ring buffer of 100 entries', async () => {
    const store = new NetworkLogStore({
      getMaxEntries: () => 250
    });

    for (let index = 0; index < 105; index += 1) {
      await store.record({
        requestId: `req-${index}`,
        method: 'GET',
        url: `https://fm.example.com/request/${index}`,
        relativeUrl: `/request/${index}`,
        durationMs: index
      });
    }

    const entries = store.listEntries();
    expect(entries).toHaveLength(100);
    expect(entries[0]?.requestId).toBe('req-104');
    expect(entries[99]?.requestId).toBe('req-5');
  });
});
