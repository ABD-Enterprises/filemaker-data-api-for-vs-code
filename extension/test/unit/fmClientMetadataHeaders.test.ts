import { expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { createAxiosResponse, InMemorySecretStorage } from './mocks';

// Exercise the previously untested header-normalization branches through the public client.
it.each([
  { header: '"version-1"', expected: '"version-1"' },
  { header: ['"version-1"', '"version-2"'], expected: '"version-1"' },
  { header: 17, expected: undefined },
  { header: [], expected: undefined }
])('uses only a string or the first string header for metadata caching ($header)', async ({ header, expected }) => {
  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  await secrets.setSessionToken('p', 'token');
  const metadata = { fieldMetaData: [{ name: ' Name ', result: 'text' }] };
  const request = vi.fn()
    .mockResolvedValueOnce({ ...createAxiosResponse({
      data: { response: metadata, messages: [{ code: '0', message: 'OK' }] }
    }), headers: { ETag: header } })
    .mockResolvedValueOnce({ ...createAxiosResponse({ data: undefined }), status: 304 });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new FMClient(secrets, logger, undefined, { request } as never);
  const profile = { id: 'p', name: 'Test', authMode: 'direct' as const, serverUrl: 'https://fm.example.test', database: 'DB' };

  const first = await client.getLayoutMetadata(profile, ' Layout ');
  expect(await client.getLayoutMetadata(profile, ' Layout ')).toBe(first);
  expect(first).toEqual(metadata);
  expect(request.mock.calls[1]?.[0].headers['If-None-Match']).toBe(expected);
});
