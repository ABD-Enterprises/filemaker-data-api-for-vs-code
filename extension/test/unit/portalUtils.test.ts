import { describe, it, expect } from 'vitest';

import {
  extractPortals,
  extractPortalMetadata,
  buildPortalParams
} from '../../src/utils/portalUtils';
import type { FileMakerRecord } from '../../src/types/fm';

describe('extractPortals', () => {
  it('extracts portal data from a record', () => {
    const record: FileMakerRecord = {
      recordId: '1',
      fieldData: { Name: 'Test' },
      portalData: {
        LineItems: [
          { recordId: '10', 'LineItems::Product': 'Widget', 'LineItems::Qty': 5 },
          { recordId: '11', 'LineItems::Product': 'Gadget', 'LineItems::Qty': 3 }
        ]
      }
    };

    const portals = extractPortals(record);

    expect(portals).toHaveLength(1);
    expect(portals[0]?.name).toBe('LineItems');
    expect(portals[0]?.recordCount).toBe(2);
    expect(portals[0]?.fieldNames).toContain('LineItems::Product');
    expect(portals[0]?.fieldNames).toContain('LineItems::Qty');
    expect(portals[0]?.fieldNames).not.toContain('recordId');
  });

  it('handles multiple portals', () => {
    const record: FileMakerRecord = {
      recordId: '1',
      fieldData: {},
      portalData: {
        Items: [{ recordId: '1', 'Items::Name': 'A' }],
        Notes: [{ recordId: '2', 'Notes::Text': 'Hello' }]
      }
    };

    const portals = extractPortals(record);
    expect(portals).toHaveLength(2);
  });

  it('returns empty array when no portalData', () => {
    const record: FileMakerRecord = { recordId: '1', fieldData: {} };
    expect(extractPortals(record)).toEqual([]);
  });

  it('returns empty array when portalData is null', () => {
    const record = { recordId: '1', fieldData: {}, portalData: null } as unknown as FileMakerRecord;
    expect(extractPortals(record)).toEqual([]);
  });

  it('handles empty portal arrays', () => {
    const record: FileMakerRecord = {
      recordId: '1',
      fieldData: {},
      portalData: { Empty: [] }
    };

    const portals = extractPortals(record);
    expect(portals).toHaveLength(1);
    expect(portals[0]?.recordCount).toBe(0);
    expect(portals[0]?.fieldNames).toEqual([]);
  });
});

describe('extractPortalMetadata', () => {
  it('extracts portal field metadata', () => {
    const metadata = {
      portalMetaData: {
        LineItems: [
          { name: 'LineItems::Product', type: 'normal', result: 'text' },
          { name: 'LineItems::Qty', type: 'normal', result: 'number' }
        ]
      }
    };

    const result = extractPortalMetadata(metadata);
    expect(result.LineItems).toHaveLength(2);
    expect(result.LineItems?.[0]?.name).toBe('LineItems::Product');
    expect(result.LineItems?.[0]?.result).toBe('text');
  });

  it('returns empty object when no portalMetaData', () => {
    expect(extractPortalMetadata({})).toEqual({});
  });

  it('handles multiple portals', () => {
    const metadata = {
      portalMetaData: {
        A: [{ name: 'A::X', result: 'text' }],
        B: [{ name: 'B::Y', result: 'number' }]
      }
    };

    const result = extractPortalMetadata(metadata);
    expect(Object.keys(result)).toEqual(['A', 'B']);
  });
});

describe('buildPortalParams', () => {
  it('builds portal parameter with names', () => {
    const params = buildPortalParams([{ name: 'LineItems' }, { name: 'Notes' }]);

    expect(params.portal).toBe('["LineItems","Notes"]');
  });

  it('includes limit and offset per portal', () => {
    const params = buildPortalParams([
      { name: 'LineItems', limit: 10, offset: 5 }
    ]);

    expect(params.portal).toBe('["LineItems"]');
    expect(params['_limit.LineItems']).toBe(10);
    expect(params['_offset.LineItems']).toBe(5);
  });

  it('returns empty object for no portals', () => {
    expect(buildPortalParams([])).toEqual({});
  });

  it('omits limit/offset when not specified', () => {
    const params = buildPortalParams([{ name: 'Items' }]);
    expect(params.portal).toBeDefined();
    expect(params['_limit.Items']).toBeUndefined();
    expect(params['_offset.Items']).toBeUndefined();
  });
});
