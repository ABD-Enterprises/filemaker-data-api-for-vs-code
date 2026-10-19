import { describe, expect, it } from 'vitest';

import { extractScriptNames } from '../../src/utils/scriptParser';

describe('extractScriptNames', () => {
  it('extracts names from mixed script payloads', () => {
    const raw = [
      { name: 'Top Script' },
      {
        name: 'Folder',
        isFolder: true,
        scripts: [{ scriptName: 'Nested Script 1' }, { script: 'Nested Script 2' }]
      },
      'Inline Script'
    ];

    const names = extractScriptNames(raw);

    expect(names).toEqual(['Top Script', 'Nested Script 1', 'Nested Script 2', 'Inline Script']);
  });

  it('deduplicates names and ignores invalid values', () => {
    const raw = {
      scripts: [
        { name: 'Duplicate' },
        { scriptName: 'Duplicate' },
        { invalid: true },
        null,
        42
      ]
    };

    const names = extractScriptNames(raw);

    expect(names).toEqual(['Duplicate']);
  });

  it('keeps names exactly (a leading or trailing space is part of the name) and drops blank ones', () => {
    expect(extractScriptNames([{ name: ' Echo' }, { name: 'Echo' }, { name: 'Echo ' }, { name: '   ' }, ' Inline '])).toEqual([' Echo', 'Echo', 'Echo ', ' Inline ']);
  });
});
