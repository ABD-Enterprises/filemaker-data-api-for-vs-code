import { describe, it, expect } from 'vitest';

import { extractValueLists } from '../../src/utils/valueListParser';

describe('extractValueLists', () => {
  it('extracts value lists from valid metadata', () => {
    const metadata = {
      valueLists: [
        {
          name: 'Colors',
          values: [
            { value: 'Red', displayValue: 'Red' },
            { value: 'Blue', displayValue: 'Blue' },
            { value: 'Green', displayValue: 'Green' }
          ]
        },
        {
          name: 'Sizes',
          values: [
            { value: 'S', displayValue: 'Small' },
            { value: 'M', displayValue: 'Medium' },
            { value: 'L', displayValue: 'Large' }
          ]
        }
      ]
    };

    const result = extractValueLists(metadata);

    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('Colors');
    expect(result[0]?.values).toHaveLength(3);
    expect(result[0]?.values[0]).toEqual({ value: 'Red', displayValue: 'Red' });
    expect(result[1]?.name).toBe('Sizes');
    expect(result[1]?.values[1]).toEqual({ value: 'M', displayValue: 'Medium' });
  });

  it('returns empty array when no valueLists field', () => {
    expect(extractValueLists({})).toEqual([]);
  });

  it('returns empty array when valueLists is not an array', () => {
    expect(extractValueLists({ valueLists: 'invalid' })).toEqual([]);
  });

  it('skips entries without a name', () => {
    const metadata = {
      valueLists: [
        { values: [{ value: 'A', displayValue: 'A' }] },
        { name: 'Valid', values: [{ value: 'B', displayValue: 'B' }] }
      ]
    };

    const result = extractValueLists(metadata);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Valid');
  });

  it('handles entries with empty values array', () => {
    const metadata = {
      valueLists: [{ name: 'Empty', values: [] }]
    };

    const result = extractValueLists(metadata);
    expect(result).toHaveLength(1);
    expect(result[0]?.values).toEqual([]);
  });

  it('handles entries with missing values field', () => {
    const metadata = {
      valueLists: [{ name: 'NoValues' }]
    };

    const result = extractValueLists(metadata);
    expect(result).toHaveLength(1);
    expect(result[0]?.values).toEqual([]);
  });

  it('uses value as displayValue fallback', () => {
    const metadata = {
      valueLists: [
        {
          name: 'Test',
          values: [{ value: 'OnlyValue' }]
        }
      ]
    };

    const result = extractValueLists(metadata);
    expect(result[0]?.values[0]).toEqual({ value: 'OnlyValue', displayValue: 'OnlyValue' });
  });
});
