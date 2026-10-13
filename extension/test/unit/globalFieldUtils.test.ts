import { describe, it, expect } from 'vitest';

import {
  buildGlobalFieldsPayload,
  parseGlobalFieldsPayload,
  isValidGlobalFieldName
} from '../../src/utils/globalFieldUtils';

describe('buildGlobalFieldsPayload', () => {
  it('builds payload from entries', () => {
    const result = buildGlobalFieldsPayload([
      { fieldName: 'Globals::Color', value: 'Red' },
      { fieldName: 'Globals::Size', value: 'Large' }
    ]);
    expect(result).toEqual({ 'Globals::Color': 'Red', 'Globals::Size': 'Large' });
  });

  it('skips entries with empty field names', () => {
    const result = buildGlobalFieldsPayload([
      { fieldName: '', value: 'ignored' },
      { fieldName: 'Valid', value: 'kept' }
    ]);
    expect(result).toEqual({ Valid: 'kept' });
  });

  it('trims field names', () => {
    const result = buildGlobalFieldsPayload([{ fieldName: '  Field  ', value: 'v' }]);
    expect(result).toEqual({ Field: 'v' });
  });

  it('returns empty object for empty array', () => {
    expect(buildGlobalFieldsPayload([])).toEqual({});
  });
});

describe('parseGlobalFieldsPayload', () => {
  it('parses globalFields from a request payload', () => {
    const result = parseGlobalFieldsPayload({
      globalFields: { 'Globals::X': 'hello', 'Globals::Y': 'world' }
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ fieldName: 'Globals::X', value: 'hello' });
  });

  it('returns empty for missing globalFields', () => {
    expect(parseGlobalFieldsPayload({})).toEqual([]);
  });

  it('filters out non-string values', () => {
    const result = parseGlobalFieldsPayload({
      globalFields: { good: 'yes', bad: 42 }
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.fieldName).toBe('good');
  });
});

describe('isValidGlobalFieldName', () => {
  it('accepts normal field names', () => {
    expect(isValidGlobalFieldName('Globals::Color')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidGlobalFieldName('')).toBe(false);
    expect(isValidGlobalFieldName('   ')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isValidGlobalFieldName('Field\x00Name')).toBe(false);
  });
});
