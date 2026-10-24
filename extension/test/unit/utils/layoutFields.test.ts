import { describe, expect, it } from 'vitest';

import { extractLayoutFieldNames } from '../../../src/utils/layoutFields';

describe('extractLayoutFieldNames', () => {
  it('returns [] for non-objects', () => {
    expect(extractLayoutFieldNames(null)).toEqual([]);
    expect(extractLayoutFieldNames(undefined)).toEqual([]);
    expect(extractLayoutFieldNames('x')).toEqual([]);
    expect(extractLayoutFieldNames(42)).toEqual([]);
    expect(extractLayoutFieldNames([])).toEqual([]);
  });

  it('reads regular fields under response.fieldMetaData', () => {
    const metadata = {
      response: {
        fieldMetaData: [
          { name: 'firstName', type: 'text' },
          { name: 'lastName', type: 'text' },
          { name: 'age', type: 'number' }
        ]
      }
    };
    expect(extractLayoutFieldNames(metadata)).toEqual(['age', 'firstName', 'lastName']);
  });

  it('reads top-level fieldMetaData when response wrapper is absent', () => {
    expect(
      extractLayoutFieldNames({
        fieldMetaData: [{ name: 'A' }, { name: 'B' }]
      })
    ).toEqual(['A', 'B']);
  });

  it('walks portalMetaData related-table fields', () => {
    const metadata = {
      response: {
        fieldMetaData: [{ name: 'orderId' }],
        portalMetaData: {
          LineItems: [{ name: 'sku' }, { name: 'qty' }],
          Payments: [{ name: 'amount' }]
        }
      }
    };
    expect(extractLayoutFieldNames(metadata)).toEqual([
      'amount',
      'orderId',
      'qty',
      'sku'
    ]);
  });

  it('deduplicates names appearing in both regular and portal arrays', () => {
    const metadata = {
      response: {
        fieldMetaData: [{ name: 'shared' }],
        portalMetaData: {
          rel: [{ name: 'shared' }, { name: 'unique' }]
        }
      }
    };
    expect(extractLayoutFieldNames(metadata)).toEqual(['shared', 'unique']);
  });

  it('ignores items without a string name', () => {
    expect(
      extractLayoutFieldNames({
        fieldMetaData: [{ name: 'good' }, { type: 'text' }, { name: 42 }, { name: '' }]
      })
    ).toEqual(['good']);
  });
});
