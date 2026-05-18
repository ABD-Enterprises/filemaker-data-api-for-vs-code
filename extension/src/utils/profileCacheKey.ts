import type { ConnectionProfile } from '../types/fm';

/**
 * Cache-key schema version. Bump this if the composition changes in a way that
 * could collide with previously persisted entries. In-memory consumers don't
 * need to care across restarts, but persistent stores can use it to invalidate.
 */
export const PROFILE_CACHE_KEY_VERSION = 'v2';

/**
 * Normalize a serverUrl to a stable canonical form for use in cache keys.
 *
 * - lowercases scheme + host
 * - strips default ports (443 for https, 80 for http)
 * - strips trailing slashes
 * - falls back to the raw value (lowercased + trimmed) when URL parsing fails,
 *   so unparseable strings don't silently collide
 */
export function normalizeServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const url = new URL(trimmed);
    const scheme = url.protocol.toLowerCase();
    const host = url.hostname.toLowerCase();
    const isDefaultPort =
      (scheme === 'https:' && (url.port === '' || url.port === '443')) ||
      (scheme === 'http:' && (url.port === '' || url.port === '80'));
    const portSegment = isDefaultPort ? '' : `:${url.port}`;
    // Path is intentionally excluded — apiBasePath carries that, and the
    // serverUrl portion of the cache key is identity, not routing.
    return `${scheme}//${host}${portSegment}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * Build a cache key that uniquely identifies the FM resource a profile points at.
 *
 * Includes profile.id (for trust/auth distinction) AND normalized serverUrl + database
 * + apiBasePath + apiVersionPath (so editing a profile to point at a different server
 * invalidates the previously cached metadata).
 *
 * When a layout name is provided, it is appended; otherwise the key identifies the
 * profile-level scope (used for top-level caches like listLayouts).
 */
export function buildProfileCacheKey(profile: ConnectionProfile, layout?: string): string {
  const server = normalizeServerUrl(profile.serverUrl);
  const apiBasePath = profile.apiBasePath ?? '/fmi/data';
  const versionPath = profile.apiVersionPath ?? 'vLatest';
  const base = `${PROFILE_CACHE_KEY_VERSION}::${profile.id}::${server}::${profile.database}::${apiBasePath}::${versionPath}`;
  return layout === undefined ? base : `${base}::${layout}`;
}

/**
 * Returns true if a cache key produced by buildProfileCacheKey belongs to the given profile id.
 *
 * Encapsulates the key layout so prefix-matching consumers (invalidateProfile)
 * don't have to know that the version prefix sits before the profile id.
 */
export function cacheKeyMatchesProfile(key: string, profileId: string): boolean {
  return key.startsWith(`${PROFILE_CACHE_KEY_VERSION}::${profileId}::`);
}
