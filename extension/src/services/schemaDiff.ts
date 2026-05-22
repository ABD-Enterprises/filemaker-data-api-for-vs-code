import type {
  FieldDiffAttributeChange,
  FileMakerFieldMetadata,
  SchemaDiffResult,
  SchemaSnapshot
} from '../types/fm';
import { stableStringify } from '../utils/hash';

export interface SchemaDiffInput {
  profileId: string;
  layout: string;
  olderSnapshotId?: string;
  newerSnapshotId?: string;
  beforeFields: FileMakerFieldMetadata[];
  afterFields: FileMakerFieldMetadata[];
}

export function diffSchemaFields(input: SchemaDiffInput): SchemaDiffResult {
  const beforeByName = new Map(input.beforeFields.map((field) => [field.name, field]));
  const afterByName = new Map(input.afterFields.map((field) => [field.name, field]));

  const added: FileMakerFieldMetadata[] = [];
  const removed: FileMakerFieldMetadata[] = [];
  const unchanged: FileMakerFieldMetadata[] = [];
  const changed: SchemaDiffResult['changed'] = [];

  for (const [fieldName, beforeField] of beforeByName.entries()) {
    const afterField = afterByName.get(fieldName);
    if (!afterField) {
      removed.push(beforeField);
      continue;
    }

    const attributeChanges = diffFieldAttributes(beforeField, afterField);
    if (attributeChanges.length > 0) {
      changed.push({
        fieldName,
        before: beforeField,
        after: afterField,
        changes: attributeChanges
      });
    } else {
      unchanged.push(afterField);
    }
  }

  for (const [fieldName, afterField] of afterByName.entries()) {
    if (!beforeByName.has(fieldName)) {
      added.push(afterField);
    }
  }

  return {
    profileId: input.profileId,
    layout: input.layout,
    olderSnapshotId: input.olderSnapshotId,
    newerSnapshotId: input.newerSnapshotId,
    comparedAt: new Date().toISOString(),
    added: sortFieldsByName(added),
    removed: sortFieldsByName(removed),
    unchanged: sortFieldsByName(unchanged),
    changed: changed.sort((left, right) => left.fieldName.localeCompare(right.fieldName)),
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length
    },
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0
  };
}

export function diffSchemaSnapshots(
  olderSnapshot: SchemaSnapshot,
  newerSnapshot: SchemaSnapshot,
  beforeFields: FileMakerFieldMetadata[],
  afterFields: FileMakerFieldMetadata[]
): SchemaDiffResult {
  return diffSchemaFields({
    profileId: newerSnapshot.profileId,
    layout: newerSnapshot.layout,
    olderSnapshotId: olderSnapshot.id,
    newerSnapshotId: newerSnapshot.id,
    beforeFields,
    afterFields
  });
}

function diffFieldAttributes(
  beforeField: FileMakerFieldMetadata,
  afterField: FileMakerFieldMetadata
): FieldDiffAttributeChange[] {
  const beforeComparable = buildComparableField(beforeField);
  const afterComparable = buildComparableField(afterField);
  const keys = Array.from(new Set([...Object.keys(beforeComparable), ...Object.keys(afterComparable)])).sort();
  const changes: FieldDiffAttributeChange[] = [];

  for (const key of keys) {
    const before = beforeComparable[key];
    const after = afterComparable[key];

    if (!isEqual(before, after)) {
      changes.push({
        attribute: key,
        before,
        after
      });
    }
  }

  return changes;
}

function buildComparableField(field: FileMakerFieldMetadata): Record<string, unknown> {
  const comparable: Record<string, unknown> = {};

  const keys = Object.keys(field).sort();

  for (const key of keys) {
    if (key === 'name') {
      continue;
    }

    const value = field[key];
    if (value === undefined) {
      continue;
    }

    comparable[key] = value;
  }

  if (comparable.type === undefined && comparable.result !== undefined) {
    comparable.type = comparable.result;
  }

  return comparable;
}

function isEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  return stableStringify(left) === stableStringify(right);
}

function sortFieldsByName(fields: FileMakerFieldMetadata[]): FileMakerFieldMetadata[] {
  return [...fields].sort((left, right) => left.name.localeCompare(right.name));
}
