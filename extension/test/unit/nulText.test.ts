import { describe, expect, it } from 'vitest';
import { containsNulText, nulTextFields, removeNulText } from '../../src/utils/nulText';

describe('NUL text protection', () => {
  it('detects only U+0000 in values, including repeating values, without changing names', () => {
    const fields = { ' Name ': ['A\0B', 'C\u200bD\ufeffE'], 'Photo': null, Count: 5 };
    expect(nulTextFields(fields)).toEqual([' Name ']);
    expect(removeNulText(fields)).toEqual({ ...fields, ' Name ': ['AB', 'C\u200bD\ufeffE'] });
    expect(fields[' Name '][0]).toBe('A\0B');
    expect(containsNulText({ name: { nested: 'a\0b' } })).toBe(true);
    expect(containsNulText([false, null, 0, '', 'A\u200bB\ufeffC'])).toBe(false);
  });
  it('removes every NUL in strings, repeating values and nested values without changing the input', () => {
    const fields = { Name: 'A\0B\0C', Repeats: ['A\0B\0C', '\0\0'], Nested: { text: 'A\0B\0C' } };
    expect(nulTextFields(fields)).toEqual(['Name', 'Repeats', 'Nested']);
    expect(removeNulText(fields)).toEqual({ Name: 'ABC', Repeats: ['ABC', ''], Nested: { text: 'ABC' } });
    expect(fields.Nested.text).toBe('A\0B\0C');
    expect(fields.Repeats).toEqual(['A\0B\0C', '\0\0']);
  });
});
