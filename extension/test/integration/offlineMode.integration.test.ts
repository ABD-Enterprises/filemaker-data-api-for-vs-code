import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it, vi } from 'vitest';

import { OfflineModeService } from '../../src/offline/offlineModeService';
import { SchemaService } from '../../src/services/schemaService';
import type { ConnectionProfile } from '../../src/types/fm';

function createProfile(): ConnectionProfile {
  return {
    id: 'dev-profile',
    name: 'Dev',
    authMode: 'direct',
    serverUrl: 'https://fm.local',
    database: 'DevDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

function createConfiguration(overrides?: Record<string, unknown>) {
  const values: Record<string, unknown> = {
    'offline.mode': true,
    'schema.hashAlgorithm': 'sha256',
    ...(overrides ?? {})
  };

  return {
    get<T>(key: string, fallback?: T): T {
      if (key in values) {
        return values[key] as T;
      }

      return fallback as T;
    },
    update: vi.fn(async (key: string, value: unknown) => {
      values[key] = value;
    })
  };
}

describe('offline mode integration', () => {
  it('serves metadata from offline cache when offline mode is enabled', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'fm-offline-'));
    const profile = createProfile();
    const configuration = createConfiguration();

    const offlineModeService = new OfflineModeService(
      {
        warn: vi.fn()
      },
      {
        getWorkspaceRoot: () => workspaceRoot,
        getConfiguration: () => configuration as never,
        isWorkspaceTrusted: () => true
      }
    );

    const metadata = {
      fieldMetaData: [
        { name: 'FirstName', type: 'text' },
        { name: 'LastName', type: 'text' }
      ]
    };

    await offlineModeService.cacheLayoutMetadata(profile, 'Contacts', metadata);

    const fmClient = {
      getLayoutMetadata: vi.fn(async () => {
        throw new Error('Network should not be used in offline mode.');
      })
    };

    const schemaService = new SchemaService(
      fmClient as never,
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      {
        offlineModeService
      }
    );

    const result = await schemaService.getLayoutSchema(profile, 'Contacts');

    expect(result.supported).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(result.fields.map((field) => field.name)).toEqual(['FirstName', 'LastName']);
    expect(fmClient.getLayoutMetadata).not.toHaveBeenCalled();
  });

  it('returns friendly message when offline cache is missing', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'fm-offline-empty-'));
    const profile = createProfile();
    const configuration = createConfiguration();

    const offlineModeService = new OfflineModeService(
      {
        warn: vi.fn()
      },
      {
        getWorkspaceRoot: () => workspaceRoot,
        getConfiguration: () => configuration as never,
        isWorkspaceTrusted: () => true
      }
    );

    const schemaService = new SchemaService(
      {
        getLayoutMetadata: vi.fn(async () => ({}))
      } as never,
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      {
        offlineModeService
      }
    );

    const result = await schemaService.getLayoutSchema(profile, 'Contacts');
    expect(result.supported).toBe(false);
    expect(result.message).toContain('Offline mode is enabled');
  });
});
