import { describe, expect, it, vi } from 'vitest';

import { SchemaService } from '../../../src/services/schemaService';
import { FMClientError } from '../../../src/services/errors';
import type { FMClient } from '../../../src/services/fmClient';
import type { OfflineModeService } from '../../../src/offline/offlineModeService';
import type { ConnectionProfile } from '../../../src/types/fm';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: 'Dev',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest',
    username: 'user',
    ...overrides
  };
}

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function metadataWith(fields: Array<{ name: string; type?: string }>): Record<string, unknown> {
  return {
    fieldMetaData: fields
  };
}

describe('SchemaService.getLayoutSchema', () => {
  it('returns disabled-message when isMetadataEnabled is false', async () => {
    const fmClient = { getLayoutMetadata: vi.fn() } as unknown as FMClient;
    const svc = new SchemaService(fmClient, createLogger(), {
      isMetadataEnabled: () => false
    });
    const result = await svc.getLayoutSchema(profile(), 'Contacts');
    expect(result.supported).toBe(false);
    expect(result.fromCache).toBe(false);
    expect(result.message).toMatch(/disabled/i);
    expect(fmClient.getLayoutMetadata).not.toHaveBeenCalled();
  });

  it('fetches once and serves subsequent calls from cache within TTL', async () => {
    const getLayoutMetadata = vi
      .fn()
      .mockResolvedValue(metadataWith([{ name: 'firstName' }, { name: 'lastName' }]));
    const fmClient = { getLayoutMetadata } as unknown as FMClient;
    const svc = new SchemaService(fmClient, createLogger(), {
      getCacheTtlMs: () => 60_000
    });

    const first = await svc.getLayoutSchema(profile(), 'Contacts');
    const second = await svc.getLayoutSchema(profile(), 'Contacts');

    expect(getLayoutMetadata).toHaveBeenCalledTimes(1);
    expect(first.supported).toBe(true);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.fields.map((f) => f.name)).toEqual(['firstName', 'lastName']);
  });

  it('re-fetches after TTL expiry', async () => {
    const getLayoutMetadata = vi
      .fn()
      .mockResolvedValueOnce(metadataWith([{ name: 'a' }]))
      .mockResolvedValueOnce(metadataWith([{ name: 'a' }, { name: 'b' }]));
    const fmClient = { getLayoutMetadata } as unknown as FMClient;

    let ttl = 60_000;
    const svc = new SchemaService(fmClient, createLogger(), {
      getCacheTtlMs: () => ttl
    });

    await svc.getLayoutSchema(profile(), 'Contacts');
    ttl = -1; // force expired on next check
    await svc.getLayoutSchema(profile(), 'Contacts');
    expect(getLayoutMetadata).toHaveBeenCalledTimes(2);
  });

  it('caches unsupported-metadata error responses (404/405/501) as a sentinel', async () => {
    const getLayoutMetadata = vi.fn().mockRejectedValue(
      new FMClientError('not found', { status: 404 })
    );
    const fmClient = { getLayoutMetadata } as unknown as FMClient;
    const svc = new SchemaService(fmClient, createLogger());

    const first = await svc.getLayoutSchema(profile(), 'Contacts');
    const second = await svc.getLayoutSchema(profile(), 'Contacts');

    expect(first.supported).toBe(false);
    expect(first.message).toMatch(/not supported/i);
    expect(getLayoutMetadata).toHaveBeenCalledTimes(1); // second served from cache
    expect(second.fromCache).toBe(true);
  });

  it('does not cache unexpected errors (rethrows so caller can react)', async () => {
    const getLayoutMetadata = vi
      .fn()
      .mockRejectedValueOnce(new FMClientError('boom', { status: 500 }));
    const fmClient = { getLayoutMetadata } as unknown as FMClient;
    const svc = new SchemaService(fmClient, createLogger());

    await expect(svc.getLayoutSchema(profile(), 'Contacts')).rejects.toThrow(/boom/);
  });

  it('serves cached offline metadata when offlineMode is enabled and skips fmClient', async () => {
    const offlineModeService: Partial<OfflineModeService> = {
      isOfflineModeEnabled: () => true,
      getCachedLayoutMetadata: vi.fn().mockResolvedValue({
        metadata: metadataWith([{ name: 'cachedField' }]),
        hash: 'abc',
        capturedAt: '2026-01-01T00:00:00Z'
      }),
      cacheLayoutMetadata: vi.fn()
    };
    const getLayoutMetadata = vi.fn();
    const fmClient = { getLayoutMetadata } as unknown as FMClient;
    const svc = new SchemaService(fmClient, createLogger(), {
      offlineModeService: offlineModeService as never
    });

    const result = await svc.getLayoutSchema(profile(), 'Contacts');
    expect(result.fromCache).toBe(true);
    expect(result.fields.map((f) => f.name)).toEqual(['cachedField']);
    expect(getLayoutMetadata).not.toHaveBeenCalled();
  });

  it('returns no-cache-available message when offline + cache miss', async () => {
    const offlineModeService: Partial<OfflineModeService> = {
      isOfflineModeEnabled: () => true,
      getCachedLayoutMetadata: vi.fn().mockResolvedValue(undefined)
    };
    const fmClient = { getLayoutMetadata: vi.fn() } as unknown as FMClient;
    const svc = new SchemaService(fmClient, createLogger(), {
      offlineModeService: offlineModeService as never
    });

    const result = await svc.getLayoutSchema(profile(), 'Contacts');
    expect(result.supported).toBe(false);
    expect(result.message).toMatch(/offline/i);
  });

  it('invalidateProfile clears only the matching profile entries', async () => {
    const getLayoutMetadata = vi
      .fn()
      .mockResolvedValueOnce(metadataWith([{ name: 'a' }]))
      .mockResolvedValueOnce(metadataWith([{ name: 'b' }]))
      .mockResolvedValueOnce(metadataWith([{ name: 'a-refetched' }]));
    const fmClient = { getLayoutMetadata } as unknown as FMClient;
    const svc = new SchemaService(fmClient, createLogger());

    await svc.getLayoutSchema(profile({ id: 'p1' }), 'Contacts');
    await svc.getLayoutSchema(profile({ id: 'p2' }), 'Contacts');
    svc.invalidateProfile('p1');
    const refetched = await svc.getLayoutSchema(profile({ id: 'p1' }), 'Contacts');
    expect(refetched.fromCache).toBe(false);
    expect(refetched.fields.map((f) => f.name)).toEqual(['a-refetched']);
    expect(getLayoutMetadata).toHaveBeenCalledTimes(3);
  });

  it('invalidateAll clears every entry', async () => {
    const getLayoutMetadata = vi
      .fn()
      .mockResolvedValueOnce(metadataWith([{ name: 'a' }]))
      .mockResolvedValueOnce(metadataWith([{ name: 'b' }]));
    const fmClient = { getLayoutMetadata } as unknown as FMClient;
    const svc = new SchemaService(fmClient, createLogger());

    await svc.getLayoutSchema(profile(), 'Contacts');
    svc.invalidateAll();
    await svc.getLayoutSchema(profile(), 'Contacts');
    expect(getLayoutMetadata).toHaveBeenCalledTimes(2);
  });
});
