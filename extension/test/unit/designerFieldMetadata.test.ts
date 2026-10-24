import { describe, expect, it } from 'vitest';
import { boundedDesignerFields, designerLayoutMetadata } from '../../src/fmweb/fieldMetadata';

describe('designer metadata', () => {
  it('uses result type ahead of storage type and carries multiline and options metadata', () => {
    expect(designerLayoutMetadata(' Layout ', { fieldMetaData: [
      { name: ' Calc ', type: 'calculation', result: 'number' },
      { name: 'Notes', result: 'text', multiline: true },
      { name: 'Choice', displayType: 'checkbox', values: ['a', 'b', 'c'] }
    ] }).fields).toEqual([
      { name: ' Calc ', type: 'number', multiline: false, kind: 'calculation', required: false },
      { name: 'Notes', type: 'text', multiline: true, kind: 'normal', required: false },
      { name: 'Choice', displayType: 'checkbox', optionCount: 3, multiline: false, kind: 'normal', required: false, options: ['a', 'b', 'c'] }
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

it('resolves exact named value lists from Data API response metadata', () => {
  const parsed = designerLayoutMetadata(' Layout ', { response: {
    fieldMetaData: [{ name: ' Choice ', displayType: 'radioButtons', valueList: ' Options ' }],
    valueLists: [{ name: 'Options', values: ['wrong'] }, { name: ' Options ', values: [
      { value: 'a', displayValue: 'A' }, { value: 'b', displayValue: 'B' }, { value: 'c', displayValue: 'C' }
    ] }]
  } });
  expect(parsed.fields[0]).toMatchObject({ name: ' Choice ', displayType: 'radioButtons', optionCount: 3, options: ['a', 'b', 'c'] });
});

it('bounds a source-less palette by UTF-8 JSON bytes, deduplicates exact names, and retains fallback access', () => {
  const layouts = [
    { layoutName: 'A', fields: [{ name: ' Field ', type: 'number' }, { name: 'Field', type: 'date' }], portals: [] },
    { layoutName: 'B', fields: [{ name: ' Field ', type: 'container' }, { name: '界'.repeat(100), type: 'text' }], portals: [] }
  ];
  expect(boundedDesignerFields(layouts).map((field) => field.name)).toEqual([' Field ', 'Field', '界'.repeat(100)]);
  const capped = boundedDesignerFields(layouts, 90);
  expect(capped).toEqual(layouts[0]!.fields);
  expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(90);
  expect(boundedDesignerFields(layouts, 2)).toEqual([]);
});


it('carries all read-only kinds, globals and the Editor required/multiline hints', () => {
  const fields = designerLayoutMetadata(' Exact ', { fieldMetaData: [
    { name: ' Summary ', type: 'summary', result: 'number' },
    { name: 'Photo', type: 'normal', result: 'container' },
    { name: 'Global', global: 'true', result: 'text' },
    { name: 'Notes', result: 'long text', validation: { notEmpty: true } },
    { name: 'Textbox', displayType: 'textArea' },
    { name: 'Optional', required: false, notEmpty: true }
  ] }).fields;
  expect(fields.map((field) => field.kind)).toEqual(['summary', 'container', 'global', 'normal', 'normal', 'normal']);
  expect(fields[0]?.name).toBe(' Summary ');
  expect(fields[3]).toMatchObject({ multiline: true, required: true });
  expect(fields[4]?.multiline).toBe(true);
  expect(fields[5]?.required).toBe(false);
});
