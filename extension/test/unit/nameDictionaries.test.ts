import { describe, expect, it } from 'vitest';
import { parseBatchUpdateInput } from '../../src/services/batchService';
import { RecordEditService } from '../../src/services/recordEditService';
import { SchemaSnapshotStore } from '../../src/services/schemaSnapshotStore';
import { diffSchemaFields } from '../../src/services/schemaDiff';
import { createNameMap } from '../../src/utils/nameSanitize';
import { buildGlobalFieldsPayload } from '../../src/utils/globalFieldUtils';
import { parseCompoundFindQuery } from '../../src/utils/compoundFindUtils';
import { prepareDuplicateFieldData } from '../../src/utils/duplicateRecord';
import { extractPortalMetadata } from '../../src/utils/portalUtils';
import { designerLayoutMetadata } from '../../src/fmweb/fieldMetadata';
import { recordsToCsv } from '../../src/utils/exportCsv';
import { InMemoryMemento } from './mocks';

const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', ' Exact '];
const data = Object.fromEntries(names.map((name) => [name, 'value']));
function check(actual: unknown, expected: unknown = data) {
  expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
}

describe('exact FileMaker names in dictionaries', () => {
  it('maps prototype-like names in both directions', () => {
    const map = createNameMap(names);
    for (const name of names) {
      expect(typeof map.rawToFriendly[name]).toBe('string');
      expect(map.friendlyToRaw[map.rawToFriendly[name]!]).toBe(name);
      expect(Object.hasOwn(map.rawToFriendly, name)).toBe(true);
    }
  });
  it.each([
    ['globals', () => buildGlobalFieldsPayload(names.map((fieldName) => ({ fieldName, value: 'value' })))],
    ['find criteria', () => parseCompoundFindQuery([data])[0]?.criteria],
    ['edit patches', () => new RecordEditService({} as never).computePatch({}, data)],
    ['duplicates', () => prepareDuplicateFieldData({ recordId: '1', fieldData: data })],
    ['CSV imports and exports', () => parseBatchUpdateInput(recordsToCsv([{ recordId: '1', ...data }]), 'csv')[0]?.fieldData]
  ] as const)('preserves fields in %s', (_label, build) => { check(build()); });
  it('preserves portal and designer metadata names', () => {
    const portals = Object.fromEntries(names.map((name) => [name, [{ name, type: 'normal', result: 'number' }]]));
    check(extractPortalMetadata({ portalMetaData: portals }), portals);
    const model = designerLayoutMetadata('__proto__', { portalMetaData: portals, fieldMetaData: names.map((name) => ({ name, result: 'number' })) });
    expect(model.fields.map((field) => field.name)).toEqual(names);
    expect(model.portals.map((portal) => portal.name)).toEqual(names);
  });
  it('preserves metadata dictionary keys through snapshots and diff comparisons', async () => {
    const store = new SchemaSnapshotStore(new InMemoryMemento() as never, { debug() {}, info() {}, warn() {}, error() {} });
    const snapshot = await store.captureSnapshot({ profileId: 'p', layout: '__proto__', source: 'manual', metadata: data });
    check(snapshot.metadata);
  });
  it('detects changes in prototype-like metadata attributes', () => {
    const before = JSON.parse('{"name":"__proto__","__proto__":"old"}');
    const after = JSON.parse('{"name":"__proto__","__proto__":"new"}');
    const diff = diffSchemaFields({ profileId: 'p', layout: '__proto__', beforeFields: [before], afterFields: [after] });
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.changes).toContainEqual({ attribute: '__proto__', before: 'old', after: 'new' });
  });
});
