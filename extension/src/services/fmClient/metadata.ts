import type { ConnectionProfile } from '../../types/fm';
import type { DataApiListLayoutsResponse, DataApiListScriptsResponse } from '../../types/dataApi';
import { isProxyProfile } from '../../types/fm';
import { FMClientError } from '../errors';
import { buildProfileCacheKey } from '../../utils/profileCacheKey';
import { extractLayoutNames } from '../../utils/layoutParser';
import { extractScriptNames } from '../../utils/scriptParser';
import { assertUsableUrlName } from '../../utils/urlSegment';
import type { ClientRequestControl } from './types';
import type { ClientContext } from './context';
import { DEFAULT_LAYOUT_TTL_MS } from './types';

export async function listLayouts(client: ClientContext, profile: ConnectionProfile, control?: ClientRequestControl): Promise<string[]> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'listLayouts',
      endpoint: 'GET /layouts'
    },
    async (trace) => {
      const cacheKey = buildProfileCacheKey(profile);
      const cached = client.layoutCache.get(cacheKey);
      const now = Date.now();

      if (cached && cached.expiresAt > now) {
        trace.cacheHit = true;
        return cached.layouts;
      }

      if (isProxyProfile(profile)) {
        const layouts = await client.proxyClient.listLayouts(profile, control?.signal);
        client.layoutCache.set(cacheKey, {
          layouts,
          expiresAt: now + DEFAULT_LAYOUT_TTL_MS
        });
        return layouts;
      }

      const envelope = await client.requestWithAuth<DataApiListLayoutsResponse>(
        profile,
        {
          method: 'GET',
          path: '/layouts',
          signal: control?.signal,
          maxResponseBytes: control?.maxResponseBytes
        },
        true,
        trace
      );

      const layouts = extractLayoutNames(envelope.response.layouts ?? []);

      client.layoutCache.set(cacheKey, {
        layouts,
        expiresAt: now + DEFAULT_LAYOUT_TTL_MS
      });

      return layouts;
    }
  );
}

export async function listScripts(client: ClientContext, profile: ConnectionProfile, control?: ClientRequestControl): Promise<string[]> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'listScripts',
      endpoint: 'GET /scripts'
    },
    async (trace) => {
      if (isProxyProfile(profile)) {
        return client.proxyClient.listScripts(profile, control?.signal);
      }

      const envelope = await client.requestWithAuth<DataApiListScriptsResponse>(
        profile,
        {
          method: 'GET',
          path: '/scripts',
          signal: control?.signal,
          maxResponseBytes: control?.maxResponseBytes
        },
        true,
        trace
      );

      return extractScriptNames(envelope.response.scripts ?? []);
    }
  );
}

export async function getLayoutMetadata(
  client: ClientContext,
  profile: ConnectionProfile,
  layout: string,
  control?: ClientRequestControl & {
    /** Ancillary presentation lookups omit user history; metrics still record them. */
    recordHistory?: boolean;
  }
): Promise<Record<string, unknown>> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'getLayoutMetadata',
      recordHistory: control?.recordHistory,
      layout,
      endpoint: `GET /layouts/${layout}`
    },
    async (trace) => {
      assertUsableUrlName(layout, 'layout');
      if (isProxyProfile(profile)) {
        return client.proxyClient.getLayoutMetadata(profile, layout, control?.signal);
      }

      const metadataKey = buildProfileCacheKey(profile, layout);
      const cachedMetadata = client.layoutMetadataCache.get(metadataKey);
      const etag = client.layoutMetadataEtags.get(metadataKey);
      const response = await client.requestWithAuthRaw<Record<string, unknown>>(
        profile,
        {
          method: 'GET',
          path: `/layouts/${encodeURIComponent(layout)}`,
          headers: etag
            ? {
                'If-None-Match': etag
              }
            : undefined,
          signal: control?.signal
        },
        true,
        trace
      );

      if (response.status === 304 && cachedMetadata) {
        trace.cacheHit = true;
        return cachedMetadata;
      }

      if (!response.envelope) {
        throw new FMClientError('Layout metadata response payload is empty.');
      }

      const nextEtag = response.headers['etag'];
      if (typeof nextEtag === 'string' && nextEtag.length > 0) {
        client.layoutMetadataEtags.set(metadataKey, nextEtag);
      }

      client.layoutMetadataCache.set(metadataKey, response.envelope.response);

      return response.envelope.response;
    }
  );
}
