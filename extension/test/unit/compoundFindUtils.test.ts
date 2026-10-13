import { describe, it, expect } from 'vitest';

import {
  buildCompoundFindQuery,
  parseCompoundFindQuery,
  validateCompoundFind
} from '../../src/utils/compoundFindUtils';

describe('buildCompoundFindQuery', () => {
  it('builds query from rows', () => {
    const query = buildCompoundFindQuery([
      { criteria: { Name: 'Smith' }, omit: false },
      { criteria: { City: 'Portland' }, omit: true }
    ]);

    expect(query).toEqual([
      { Name: 'Smith' },
      { City: 'Portland', omit: 'true' }
    ]);
  });

  it('skips rows with empty criteria', () => {
    const query = buildCompoundFindQuery([
      { criteria: {}, omit: false },
      { criteria: { Name: 'Jones' }, omit: false }
    ]);

    expect(query).toHaveLength(1);
    expect(query[0]).toEqual({ Name: 'Jones' });
  });

  it('returns empty array for no rows', () => {
    expect(buildCompoundFindQuery([])).toEqual([]);
  });
});

describe('parseCompoundFindQuery', () => {
  it('parses query back into rows', () => {
    const rows = parseCompoundFindQuery([
      { Name: 'Smith' },
      { City: 'Portland', omit: 'true' }
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ criteria: { Name: 'Smith' }, omit: false });
    expect(rows[1]).toEqual({ criteria: { City: 'Portland' }, omit: true });
  });

  it('handles boolean omit values', () => {
    const rows = parseCompoundFindQuery([{ X: 'Y', omit: true }]);
    expect(rows[0]?.omit).toBe(true);
  });
});

describe('validateCompoundFind', () => {
  it('returns undefined for valid query', () => {
    expect(
      validateCompoundFind([{ criteria: { Name: 'A' }, omit: false }])
    ).toBeUndefined();
  });

  it('returns error for empty rows', () => {
    expect(validateCompoundFind([])).toBe('At least one find request is required.');
  });

  it('returns error when all rows are omit', () => {
    expect(
      validateCompoundFind([{ criteria: { Name: 'A' }, omit: true }])
    ).toBe('At least one non-omit find request with criteria is required.');
  });

  it('returns error when non-omit rows have empty criteria', () => {
    expect(
      validateCompoundFind([{ criteria: {}, omit: false }])
    ).toBe('At least one non-omit find request with criteria is required.');
  });
});
