import { describe, expect, it } from 'vitest';
import { designerLayoutMetadata } from '../../src/fmweb/fieldMetadata';

describe('designer metadata', () => {
  it('uses result type ahead of storage type and carries multiline and options metadata', () => {
    expect(designerLayoutMetadata(' Layout ', { fieldMetaData: [
      { name: ' Calc ', type: 'calculation', result: 'number' },
      { name: 'Notes', result: 'text', multiline: true },
      { name: 'Choice', displayType: 'checkbox', values: ['a', 'b', 'c'] }
    ] }).fields).toEqual([
      { name: ' Calc ', type: 'number', multiline: false },
      { name: 'Notes', type: 'text', multiline: true },
      { name: 'Choice', displayType: 'checkbox', optionCount: 3, multiline: false }
    ]);
  });
  it('handles missing metadata and the response envelope without changing names', () => {
    expect(designerLayoutMetadata(' Layout ', {})).toEqual({ layoutName: ' Layout ', fields: [], portals: [] });
    expect(designerLayoutMetadata(' Layout ', { response: {
      fieldMetaData: [{ fieldName: ' Field ', result: 'time' }],
      portalMetaData: { ' Portal ': [{ name: ' Related::Field ' }] }
    } })).toMatchObject({ layoutName: ' Layout ', fields: [{ name: ' Field ', type: 'time' }], portals: [{ name: ' Portal ', fields: [' Related::Field '] }] });
  });
});
