import { describe, expect, it } from 'vitest';

import type { ConnectionProfile } from '../../../src/types/fm';
import {
  PROFILE_CACHE_KEY_VERSION,
  buildProfileCacheKey,
  normalizeServerUrl
} from '../../../src/utils/profileCacheKey';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'profile-1',
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

describe('normalizeServerUrl', () => {
  it('lowercases scheme and host', () => {
    expect(normalizeServerUrl('HTTPS://FM.EXAMPLE.COM')).toBe('https://fm.example.com');
  });

  it('strips default ports (443/80)', () => {
    expect(normalizeServerUrl('https://fm.example.com:443')).toBe('https://fm.example.com');
    expect(normalizeServerUrl('http://fm.example.com:80')).toBe('http://fm.example.com');
  });

  it('keeps non-default ports', () => {
    expect(normalizeServerUrl('https://fm.example.com:8443')).toBe('https://fm.example.com:8443');
  });

  it('strips trailing path (carried by apiBasePath in the composite key)', () => {
    expect(normalizeServerUrl('https://fm.example.com/some/path')).toBe('https://fm.example.com');
    expect(normalizeServerUrl('https://fm.example.com/')).toBe('https://fm.example.com');
  });

  it('falls back to lowercased trimmed value when URL is unparseable', () => {
    expect(normalizeServerUrl('  Not A URL  ')).toBe('not a url');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeServerUrl('')).toBe('');
    expect(normalizeServerUrl('   ')).toBe('');
  });
});

describe('buildProfileCacheKey', () => {
  it('produces the same key for the same profile + layout', () => {
    const key1 = buildProfileCacheKey(profile(), 'Contacts');
    const key2 = buildProfileCacheKey(profile(), 'Contacts');
    expect(key1).toBe(key2);
  });

  it('two profiles with the same database name but different servers produce different keys', () => {
    const devProfile = profile({ id: 'dev', serverUrl: 'https://dev.example.com' });
    const prodProfile = profile({ id: 'prod', serverUrl: 'https://prod.example.com' });
    expect(buildProfileCacheKey(devProfile, 'Contacts')).not.toBe(
      buildProfileCacheKey(prodProfile, 'Contacts')
    );
  });

  it('editing a profile to point at a different server invalidates the cache key', () => {
    const before = buildProfileCacheKey(
      profile({ serverUrl: 'https://old.example.com' }),
      'Contacts'
    );
    const after = buildProfileCacheKey(
      profile({ serverUrl: 'https://new.example.com' }),
      'Contacts'
    );
    expect(before).not.toBe(after);
  });

  it('different layouts produce different keys', () => {
    expect(buildProfileCacheKey(profile(), 'Contacts')).not.toBe(
      buildProfileCacheKey(profile(), 'Invoices')
    );
  });

  it('omits the layout suffix when no layout is supplied (profile-level scope)', () => {
    const key = buildProfileCacheKey(profile());
    expect(key.endsWith('vLatest')).toBe(true);
    expect(key.includes('::Contacts')).toBe(false);
  });

  it('normalizes serverUrl so trailing slashes / case differences are treated as the same', () => {
    expect(
      buildProfileCacheKey(profile({ serverUrl: 'https://fm.example.com' }), 'Contacts')
    ).toBe(
      buildProfileCacheKey(profile({ serverUrl: 'HTTPS://FM.example.com/' }), 'Contacts')
    );
  });

  it('includes the schema version prefix so future format changes can invalidate', () => {
    const key = buildProfileCacheKey(profile(), 'Contacts');
    expect(key.startsWith(`${PROFILE_CACHE_KEY_VERSION}::`)).toBe(true);
  });

  it('different apiVersionPath produces different keys', () => {
    expect(
      buildProfileCacheKey(profile({ apiVersionPath: 'vLatest' }), 'Contacts')
    ).not.toBe(buildProfileCacheKey(profile({ apiVersionPath: 'v1' }), 'Contacts'));
  });
});
