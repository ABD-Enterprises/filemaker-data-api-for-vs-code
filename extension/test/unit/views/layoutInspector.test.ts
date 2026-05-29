import { describe, expect, it, vi } from 'vitest';

import { LayoutInspectorProvider } from '../../../src/views/layoutInspector';
import type { ConnectionProfile } from '../../../src/types/fm';

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'Dev',
  authMode: 'direct',
  serverUrl: 'https://fm.example.com',
  database: 'CRM'
};

function createProvider() {
  const profileStore = {
    getProfile: vi.fn().mockResolvedValue(profile)
  };
  const schemaService = {
    getLayoutSchema: vi.fn().mockResolvedValue({
      supported: true,
      fromCache: false,
      fields: [
        { name: 'Name', result: 'text' },
        { name: 'GlobalStatus', result: 'text', isGlobal: true, validation: { notEmpty: true } }
      ],
      metadata: {
        portalMetaData: {
          Lines: [{ name: 'LineItems::Amount', result: 'number' }]
        },
        valueLists: [{ name: 'Statuses', values: [] }]
      }
    }),
    invalidateLayout: vi.fn()
  };

  return {
    provider: new LayoutInspectorProvider(profileStore as never, schemaService as never),
    profileStore,
    schemaService
  };
}

describe('LayoutInspectorProvider', () => {
  it('renders the four layout inspector categories for the selected layout', async () => {
    const { provider } = createProvider();
    provider.selectLayout('p1', 'Contacts');

    const children = await provider.getChildren();

    expect(children.map((item) => item.label)).toEqual([
      'Fields',
      'Portals',
      'Value Lists',
      'Field Validation'
    ]);
    expect(children.map((item) => item.description)).toEqual(['2', '1', '1', '1']);
  });

  it('uses its session cache until refresh is requested', async () => {
    const { provider, schemaService } = createProvider();
    provider.selectLayout('p1', 'Contacts');

    await provider.getChildren();
    await provider.getChildren();

    expect(schemaService.getLayoutSchema).toHaveBeenCalledTimes(1);

    await provider.refreshCurrent();
    await provider.getChildren();

    expect(schemaService.invalidateLayout).toHaveBeenCalledWith(profile, 'Contacts');
    expect(schemaService.getLayoutSchema).toHaveBeenCalledTimes(2);
  });
});
