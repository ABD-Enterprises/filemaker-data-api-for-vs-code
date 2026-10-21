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
});
