import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import * as vscode from 'vscode';

import type { ConnectionProfile } from '../types/fm';
import { hashObjectWithAlgorithm } from '../utils/hash';
import { isOfflineModeOn } from '../utils/policySetting';

const OFFLINE_CACHE_DIR = '.vscode/filemaker/offline-metadata';
const OFFLINE_INDEX_FILE = 'index.json';
const OFFLINE_SCHEMA_VERSION = 1;

interface OfflineIndexRecord {
  profileId: string;
  database: string;
  apiBasePath: string;
  apiVersionPath: string;
  layout: string;
  capturedAt: string;
  hash: string;
  fileName: string;
}

interface OfflineIndexDocument {
  schemaVersion: number;
  items: OfflineIndexRecord[];
}

interface OfflineModeServiceOptions {
  getWorkspaceRoot?: () => string | undefined;
  getConfiguration?: () => vscode.WorkspaceConfiguration;
  isWorkspaceTrusted?: () => boolean;
}

export class OfflineModeService {
  private readonly getWorkspaceRoot: () => string | undefined;
  private readonly getConfiguration: () => vscode.WorkspaceConfiguration;
  private readonly isWorkspaceTrusted: () => boolean;

  public constructor(
    private readonly logger: Pick<
      {
        warn: (message: string, meta?: unknown) => void;
      },
      'warn'
    >,
    options?: OfflineModeServiceOptions
  ) {
    this.getWorkspaceRoot = options?.getWorkspaceRoot ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    this.getConfiguration = options?.getConfiguration ?? (() => vscode.workspace.getConfiguration('filemaker'));
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted);
  }

  public isOfflineModeEnabled(): boolean {
    return isOfflineModeOn(this.getConfiguration());
  }

  public async toggleOfflineMode(enabled?: boolean): Promise<boolean> {
    const next = enabled ?? !this.isOfflineModeEnabled();
    await this.getConfiguration().update('offline.mode', next, vscode.ConfigurationTarget.Workspace);
    return next;
  }

  public async cacheLayoutMetadata(
    profile: ConnectionProfile,
    layout: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const dir = await this.ensureCacheDir();
    if (!dir) {
      return;
    }

    const hashAlgorithm = this.getConfiguration().get<string>('schema.hashAlgorithm', 'sha256');
    const hash = hashObjectWithAlgorithm(metadata, hashAlgorithm);
    const capturedAt = new Date().toISOString();

    const safeProfileId = sanitizeFileName(profile.id);
    const safeLayout = sanitizeFileName(layout);
    const fileName = `${safeProfileId}__${safeLayout}__${capturedAt.replace(/[:.]/g, '-')}.json`;

    const payload = {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      profile: {
        id: profile.id,
        database: profile.database,
        apiBasePath: profile.apiBasePath ?? '/fmi/data',
        apiVersionPath: profile.apiVersionPath ?? 'vLatest'
      },
      layout,
      capturedAt,
      hash,
      metadata
    };

    await writeFile(join(dir, fileName), JSON.stringify(payload, null, 2), 'utf8');

    const indexPath = join(dir, OFFLINE_INDEX_FILE);
    const index = await this.readIndex(indexPath);
    const key = cacheKey(profile.id, profile.database, profile.apiBasePath, profile.apiVersionPath, layout);

    const retained = index.items.filter((item) => {
      return cacheKey(item.profileId, item.database, item.apiBasePath, item.apiVersionPath, item.layout) !== key;
    });

    retained.unshift({
      profileId: profile.id,
      database: profile.database,
      apiBasePath: profile.apiBasePath ?? '/fmi/data',
      apiVersionPath: profile.apiVersionPath ?? 'vLatest',
      layout,
      capturedAt,
      hash,
      fileName
    });

    index.items = retained.slice(0, 1000);
    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  public async getCachedLayoutMetadata(
    profile: ConnectionProfile,
    layout: string
  ): Promise<{
    metadata: Record<string, unknown>;
    hash: string;
    capturedAt: string;
  } | undefined> {
    const dir = this.getCacheDir();
    if (!dir) {
      return undefined;
    }

    const indexPath = join(dir, OFFLINE_INDEX_FILE);
    const index = await this.readIndex(indexPath);
    const key = cacheKey(profile.id, profile.database, profile.apiBasePath, profile.apiVersionPath, layout);

    const match = index.items.find(
      (item) =>
        cacheKey(item.profileId, item.database, item.apiBasePath, item.apiVersionPath, item.layout) === key
    );

    if (!match) {
      return undefined;
    }

    try {
      const raw = await readFile(join(dir, match.fileName), 'utf8');
      const parsed = JSON.parse(raw) as {
        metadata?: Record<string, unknown>;
        hash?: string;
        capturedAt?: string;
      };

      if (!parsed.metadata || typeof parsed.metadata !== 'object') {
        return undefined;
      }

      return {
        metadata: parsed.metadata,
        hash: typeof parsed.hash === 'string' ? parsed.hash : match.hash,
        capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : match.capturedAt
      };
    } catch (error) {
      this.logger.warn('Failed to read offline metadata cache file.', {
        fileName: match.fileName,
        error
      });
      return undefined;
    }
  }

  public async refreshCache(
    profile: ConnectionProfile,
    listLayouts: () => Promise<string[]>,
    loadMetadata: (layout: string) => Promise<Record<string, unknown>>
  ): Promise<{ cached: number; failed: number }> {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace is untrusted. Offline cache refresh is disabled.');
    }

    const layouts = await listLayouts();
    let cached = 0;
    let failed = 0;

    for (const layout of layouts) {
      try {
        const metadata = await loadMetadata(layout);
        await this.cacheLayoutMetadata(profile, layout, metadata);
        cached += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn('Failed to refresh offline metadata for layout.', {
          profileId: profile.id,
          layout,
          error
        });
      }
    }

    return { cached, failed };
  }

  public async listCacheEntries(): Promise<OfflineIndexRecord[]> {
    const dir = this.getCacheDir();
    if (!dir) {
      return [];
    }

    const index = await this.readIndex(join(dir, OFFLINE_INDEX_FILE));
    return [...index.items];
  }

  private getCacheDir(): string | undefined {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return undefined;
    }

    return join(root, OFFLINE_CACHE_DIR);
  }

  private async ensureCacheDir(): Promise<string | undefined> {
    if (!this.isWorkspaceTrusted()) {
      return undefined;
    }

    const dir = this.getCacheDir();
    if (!dir) {
      return undefined;
    }

    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async readIndex(indexPath: string): Promise<OfflineIndexDocument> {
    try {
      const raw = await readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as OfflineIndexDocument;

      if (!Array.isArray(parsed.items)) {
        throw new Error('Invalid offline metadata index.');
      }

      return {
        schemaVersion:
          typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : OFFLINE_SCHEMA_VERSION,
        items: parsed.items.filter((item): item is OfflineIndexRecord => isOfflineIndexRecord(item))
      };
    } catch {
      return {
        schemaVersion: OFFLINE_SCHEMA_VERSION,
        items: []
      };
    }
  }
}

function isOfflineIndexRecord(value: unknown): value is OfflineIndexRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    typeof item.profileId === 'string' &&
    typeof item.database === 'string' &&
    typeof item.apiBasePath === 'string' &&
    typeof item.apiVersionPath === 'string' &&
    typeof item.layout === 'string' &&
    typeof item.capturedAt === 'string' &&
    typeof item.hash === 'string' &&
    typeof item.fileName === 'string'
  );
}

function cacheKey(
  profileId: string,
  database: string,
  apiBasePath: string | undefined,
  apiVersionPath: string | undefined,
  layout: string
): string {
  return `${profileId}::${database}::${apiBasePath ?? '/fmi/data'}::${apiVersionPath ?? 'vLatest'}::${layout}`;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}
