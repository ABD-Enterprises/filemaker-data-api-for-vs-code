import { describe, expect, it } from 'vitest';

import { createNameMap, sanitizeToIdentifier, toPascalCaseIdentifier } from '../../src/utils/nameSanitize';

describe('nameSanitize', () => {
  it('converts FileMaker names to stable TypeScript identifiers', () => {
    expect(sanitizeToIdentifier('First Name')).toBe('firstName');
    expect(sanitizeToIdentifier('1st Name')).toBe('_1stName');
    expect(sanitizeToIdentifier('class')).toBe('classField');
    expect(toPascalCaseIdentifier('first_name')).toBe('FirstName');
  });

  it('deduplicates collisions deterministically', () => {
    const map = createNameMap(['First Name', 'First-Name', 'first_name']);

    expect(map.rawToFriendly['First Name']).toBe('firstName');
    expect(map.rawToFriendly['First-Name']).toBe('firstName2');
    expect(map.rawToFriendly['first_name']).toBe('firstName3');
    expect(map.friendlyToRaw['firstName2']).toBe('First-Name');
  });
});
