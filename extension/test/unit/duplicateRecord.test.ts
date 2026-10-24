import { describe, it, expect } from 'vitest';

import {
  extractDuplicateFieldData,
  isLikelyAutoEnterField,
  prepareDuplicateFieldData
} from '../../src/utils/duplicateRecord';
import type { FileMakerRecord } from '../../src/types/fm';

describe('extractDuplicateFieldData', () => {
  it('copies fieldData from a record', () => {
    const record: FileMakerRecord = {
      recordId: '42',
      modId: '3',
      fieldData: { Name: 'Alice', Email: 'alice@test.com' }
    };

    const result = extractDuplicateFieldData(record);
    expect(result).toEqual({ Name: 'Alice', Email: 'alice@test.com' });
  });

  it('does not include recordId or modId', () => {
    const record: FileMakerRecord = {
      recordId: '1',
      modId: '1',
      fieldData: { X: 'Y' }
    };

    const result = extractDuplicateFieldData(record);
    expect(result).not.toHaveProperty('recordId');
    expect(result).not.toHaveProperty('modId');
  });

  it('returns a shallow copy (not the original)', () => {
    const record: FileMakerRecord = { recordId: '1', fieldData: { A: 'B' } };
    const result = extractDuplicateFieldData(record);
    expect(result).not.toBe(record.fieldData);
  });
});

describe('isLikelyAutoEnterField', () => {
  it('detects primary key patterns', () => {
    expect(isLikelyAutoEnterField('__pk_Contacts')).toBe(true);
    expect(isLikelyAutoEnterField('_pk_ID')).toBe(true);
    expect(isLikelyAutoEnterField('PrimaryKey')).toBe(true);
  });

  it('detects creation timestamp patterns', () => {
    expect(isLikelyAutoEnterField('CreationTimestamp')).toBe(true);
    expect(isLikelyAutoEnterField('CreatedBy')).toBe(true);
    expect(isLikelyAutoEnterField('Created_On')).toBe(true);
  });

  it('does not flag normal fields', () => {
    expect(isLikelyAutoEnterField('FirstName')).toBe(false);
    expect(isLikelyAutoEnterField('Email')).toBe(false);
    expect(isLikelyAutoEnterField('CompanyAddress')).toBe(false);
  });
});

describe('prepareDuplicateFieldData', () => {
  it('excludes auto-enter fields by default', () => {
    const record: FileMakerRecord = {
      recordId: '1',
      fieldData: {
        __pk_ID: '123',
        Name: 'Alice',
        CreationTimestamp: '2026-01-01',
        Email: 'a@test.com'
      }
    };

    const result = prepareDuplicateFieldData(record);
    expect(result).toEqual({ Name: 'Alice', Email: 'a@test.com' });
  });

  it('keeps all fields when excludeAutoEnter is false', () => {
    const record: FileMakerRecord = {
      recordId: '1',
      fieldData: { __pk_ID: '123', Name: 'Alice' }
    };

    const result = prepareDuplicateFieldData(record, false);
    expect(result).toEqual({ __pk_ID: '123', Name: 'Alice' });
  });
});
