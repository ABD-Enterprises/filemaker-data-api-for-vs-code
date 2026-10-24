import { describe, expect, it } from 'vitest';

import {
  CURRENT_LAYOUT_SCHEMA_VERSION,
  createBlankLayout,
  migrateLayoutDefinition,
  validateLayoutDefinition
} from '../../src/fmweb/layoutSchema';

describe('layout schema migration', () => {
  it('validates current schema layout', () => {
    const layout = createBlankLayout('Main');
    const validated = validateLayoutDefinition(layout);

    expect(validated.schemaVersion).toBe(CURRENT_LAYOUT_SCHEMA_VERSION);
    expect(validated.name).toBe('Main');
  });

  it('migrates legacy layout payloads without schemaVersion', () => {
    const legacy = {
      id: 'f4f83276-9978-4897-98bc-4c8d371cf7c2',
      name: 'Legacy',
      objects: [
        {
          id: 'd44ab14c-ab8a-4297-8698-47867f687911',
          type: 'text',
          name: 'text-1',
          x: 10,
          y: 20,
          width: 120,
          height: 24,
          zIndex: 0,
          text: 'Hello'
        }
      ]
    };

    const migrated = migrateLayoutDefinition(legacy);

    expect(migrated.schemaVersion).toBe(CURRENT_LAYOUT_SCHEMA_VERSION);
    expect(migrated.objects[0]?.type).toBe('text');
  });
});
