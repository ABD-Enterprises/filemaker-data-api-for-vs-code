# ADR-0003: Profile Cache Keys Include Normalized Server URL

## Status

Accepted

## Context

The extension caches FileMaker metadata such as layout lists and layout schema. Earlier cache keys that only identified the profile or database could become unsafe when a profile was edited to point at a different server, database path, API version, or environment. That could show stale metadata from another server and create confusing or unsafe user workflows.

Cache keys also need to be stable across harmless formatting differences, such as URL case and trailing slashes, while still changing when the actual FileMaker resource changes.

## Decision

Profile cache keys use a versioned format:

```text
v2::<profileId>::<normalizedServerUrl>::<database>::<apiBasePath>::<apiVersionPath>[::<layout>]
```

The normalized server URL lowercases the scheme and host, strips default ports, and removes path/trailing slash details because `apiBasePath` carries routing identity separately. The `v2::` prefix allows future key-layout changes to invalidate old keys deliberately.

Cache invalidation uses `cacheKeyMatchesProfile()` rather than ad hoc string matching so callers do not need to know the internal key layout.

## Consequences

- Editing a profile to point at another FileMaker Server changes the cache key and avoids stale metadata reuse.
- Case and trailing slash differences do not create duplicate cache entries.
- The key includes both profile id and server identity, preserving auth/trust separation while still recognizing resource changes.
- Future cache-key format changes can bump the version prefix.
- Tests should protect against partial profile-id matches, such as invalidating `p1` accidentally matching `p10`.
