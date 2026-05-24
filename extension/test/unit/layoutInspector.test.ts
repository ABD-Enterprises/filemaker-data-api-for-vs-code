import { describe, expect, it } from 'vitest';

import { buildLayoutInspectorModel } from '../../src/utils/layoutInspector';
import type { SchemaMetadataResult } from '../../src/types/fm';

describe('buildLayoutInspectorModel', () => {
  it('extracts fields, portals, value lists, globals, and validation rules', () => {
    const schema: SchemaMetadataResult = {
      supported: true,
      fromCache: false,
      fields: [
        {
          name: 'Name',
          result: 'text',
          validation: {
            notEmpty: true,
            maxCharacters: 80
          }
        },
        {
          name: 'Company::AccountGlobal',
          result: 'text',
          storage: 'global'
        }
      ],
      metadata: {
        portalMetaData: {
          InvoiceLines: [
            { name: 'LineItems::Description', result: 'text' },
            { name: 'LineItems::Amount', result: 'number' }
          ]
        },
        valueLists: [
          {
            name: 'Statuses',
            values: [{ value: 'Active', displayValue: 'Active' }]
          }
        ]
      }
    };

    const model = buildLayoutInspectorModel(schema);

    expect(model.fields).toEqual([
      {
        name: 'Name',
        type: 'text',
        repetitions: undefined,
        isGlobal: false,
        validation: { notEmpty: true, maxCharacters: 80 }
      },
      {
        name: 'Company::AccountGlobal',
        type: 'text',
        repetitions: undefined,
        isGlobal: true,
        validation: undefined
      }
    ]);
    expect(model.portals).toEqual([
      {
        key: 'InvoiceLines',
        relatedTable: 'LineItems',
        fields: [
          { name: 'LineItems::Description', type: 'text' },
          { name: 'LineItems::Amount', type: 'number' }
        ]
      }
    ]);
    expect(model.valueLists.map((valueList) => valueList.name)).toEqual(['Statuses']);
    expect(model.validations).toEqual([
      {
        fieldName: 'Name',
        summary: 'notEmpty, maxCharacters: 80',
        details: { notEmpty: true, maxCharacters: 80 }
      }
    ]);
  });
});
