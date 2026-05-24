import type { ConnectionProfile } from '../types/fm';

export const DEFAULT_WEBDIRECT_BASE_PATH = '/fmi/webd';

export interface WebDirectRecordUrlInput {
  profile: Pick<ConnectionProfile, 'serverUrl' | 'database'>;
  layout: string;
  recordId: string;
  basePath?: string;
}

export function normalizeWebDirectBasePath(
  value: string | undefined,
  fallback = DEFAULT_WEBDIRECT_BASE_PATH
): string {
  const trimmed = value?.trim() ?? '';
  const normalized = trimmed.length > 0 ? trimmed : fallback;
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return withLeadingSlash.replace(/\/+$/, '') || fallback;
}

export function buildWebDirectRecordUrl(input: WebDirectRecordUrlInput): string {
  const serverUrl = input.profile.serverUrl.trim();
  const database = input.profile.database.trim();
  const layout = input.layout.trim();
  const recordId = input.recordId.trim();

  if (!serverUrl) {
    throw new Error('Connection profile is missing a server URL.');
  }
  if (!database) {
    throw new Error('Connection profile is missing a database name.');
  }
  if (!layout) {
    throw new Error('A layout name is required to build a WebDirect URL.');
  }
  if (!recordId) {
    throw new Error('A record ID is required to build a WebDirect URL.');
  }

  const url = new URL(serverUrl);
  const baseSegments = normalizeWebDirectBasePath(input.basePath).split('/').filter(Boolean);
  const pathSegments = [...baseSegments, 'db', database, layout].map((segment) =>
    encodeURIComponent(segment)
  );

  url.pathname = `/${pathSegments.join('/')}`;
  url.search = '';
  url.hash = `recordid=${encodeURIComponent(recordId)}`;

  return url.toString();
}
