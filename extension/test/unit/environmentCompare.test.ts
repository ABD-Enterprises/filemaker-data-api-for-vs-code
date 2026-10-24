import { describe, expect, it, vi } from 'vitest';

import { EnvironmentCompareService } from '../../src/enterprise/environmentCompareService';
import type { ConnectionProfile, EnvironmentSet } from '../../src/types/fm';

function createProfiles(): ConnectionProfile[] {
  return [
    {
      id: 'dev',
      name: 'Dev',
      authMode: 'direct',
      serverUrl: 'https://dev.local',
      database: 'DB',
      username: 'admin'
    },
    {
      id: 'prod',
      name: 'Prod',
      authMode: 'direct',
      serverUrl: 'https://prod.local',
      database: 'DB',
      username: 'admin'
    }
  ];
}

function createSet(): EnvironmentSet {
  return {
    id: 'set-1',
    name: 'Dev/Test/Prod',
    profiles: ['dev', 'prod'],
    createdAt: new Date().toISOString()
  };
}

describe('EnvironmentCompareService', () => {
  it('builds environment matrix with presence and metadata hash variants', async () => {
    const profiles = createProfiles();
    const fmClient = {
      listLayouts: vi.fn(async (profile: ConnectionProfile) =>
        profile.id === 'dev' ? ['Contacts', 'Invoices'] : ['Contacts']
      ),
      getLayoutMetadata: vi.fn(async (profile: ConnectionProfile, layout: string) => ({
        layout,
        profileId: profile.id,
        fieldMetaData: [{ name: 'Name', type: profile.id === 'dev' ? 'text' : 'number' }]
      }))
    };

    const schemaService = {
      getLayoutSchema: vi.fn()
    };

    const service = new EnvironmentCompareService(fmClient as never, schemaService as never, {
      debug: vi.fn(),
      warn: vi.fn()
    });

    const result = await service.compareEnvironmentSet(createSet(), profiles, {
      concurrency: 2,
      hashAlgorithm: 'sha256'
    });

    expect(result.summary.profileCount).toBe(2);
    expect(result.summary.totalLayouts).toBe(2);
    expect(result.rows.map((row) => row.layout)).toEqual(['Contacts', 'Invoices']);

    const invoices = result.rows.find((row) => row.layout === 'Invoices');
    expect(invoices?.presence.dev).toBe(true);
    expect(invoices?.presence.prod).toBe(false);
  });

  it('diffs one layout across environments using baseline fields', async () => {
    const profiles = createProfiles();

    const fmClient = {
      listLayouts: vi.fn(),
      getLayoutMetadata: vi.fn()
    };

    const schemaService = {
      getLayoutSchema: vi.fn(async (profile: ConnectionProfile, layout: string) => {
        if (profile.id === 'dev') {
          return {
            supported: true,
            fromCache: false,
            metadata: {
              layout,
              scripts: ['SyncContacts']
            },
            fields: [{ name: 'Name', type: 'text' }]
          };
        }

        return {
          supported: true,
          fromCache: false,
          metadata: {
            layout,
            scripts: ['SyncContacts', 'RepairIndexes']
          },
          fields: [
            { name: 'Name', type: 'number' },
            { name: 'ExternalId', type: 'text' }
          ]
        };
      })
    };

    const service = new EnvironmentCompareService(fmClient as never, schemaService as never, {
      debug: vi.fn(),
      warn: vi.fn()
    });

    const diff = await service.diffLayoutAcrossEnvironments(createSet(), 'Contacts', profiles, {
      concurrency: 2,
      hashAlgorithm: 'sha256'
    });

    const prod = diff.profileResults.find((item) => item.profileId === 'prod');
    expect(prod?.available).toBe(true);
    expect(prod?.addedFields).toContain('ExternalId');
    expect(prod?.changedFields.some((field) => field.fieldName === 'Name')).toBe(true);
    expect(prod?.scripts).toContain('RepairIndexes');
  });
});
