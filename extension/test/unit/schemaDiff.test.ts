import { describe, expect, it } from 'vitest';

import { diffSchemaFields } from '../../src/services/schemaDiff';

describe('schemaDiff', () => {
  it('detects added, removed, and changed fields', () => {
    const diff = diffSchemaFields({
      profileId: 'profile-a',
      layout: 'Contacts',
      beforeFields: [
        { name: 'FirstName', type: 'text', repetitions: 1 },
        { name: 'StableName', type: 'text', repetitions: 1 },
        { name: 'LegacyCode', type: 'text', repetitions: 1 }
      ],
      afterFields: [
        { name: 'FirstName', type: 'number', repetitions: 1 },
        { name: 'StableName', type: 'text', repetitions: 1 },
        { name: 'LastName', type: 'text', repetitions: 1 }
      ]
    });

    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(diff.added.map((field) => field.name)).toEqual(['LastName']);
    expect(diff.removed.map((field) => field.name)).toEqual(['LegacyCode']);
    expect(diff.unchanged?.map((field) => field.name)).toEqual(['StableName']);
    const changed = diff.changed.at(0);
    expect(changed?.fieldName).toBe('FirstName');
    expect(changed?.changes.some((change) => change.attribute === 'type')).toBe(true);
    expect(diff.hasChanges).toBe(true);
  });

  it('returns no changes when metadata is equivalent', () => {
    const diff = diffSchemaFields({
      profileId: 'profile-a',
      layout: 'Contacts',
      beforeFields: [{ name: 'FirstName', type: 'text', repetitions: 1 }],
      afterFields: [{ name: 'FirstName', type: 'text', repetitions: 1 }]
    });

    expect(diff.hasChanges).toBe(false);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(diff.unchanged?.map((field) => field.name)).toEqual(['FirstName']);
  });
});
