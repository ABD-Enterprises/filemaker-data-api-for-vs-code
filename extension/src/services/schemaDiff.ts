import path from 'node:path';
import { Worker } from 'node:worker_threads';

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

export interface SchemaDiffCancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export type SchemaDiffWorkerRequest = SchemaDiffInput;

export type SchemaDiffWorkerMessage =
  | {
      type: 'success';
      diff: SchemaDiffResult;
    }
  | {
      type: 'error';
      message: string;
      stack?: string;
    };

export interface SchemaDiffWorkerHandle {
  postMessage(value: SchemaDiffWorkerRequest): void;
  once(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  removeAllListeners(event?: 'message' | 'error' | 'exit'): this;
  terminate(): Promise<number>;
}

export interface SchemaDiffWorkerOptions {
  workerFactory?: () => SchemaDiffWorkerHandle;
}

export class SchemaDiffCancelledError extends Error {
  public constructor() {
    super('Schema diff was cancelled.');
    this.name = 'SchemaDiffCancelledError';
  }
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

export function diffSchemaFieldsInWorker(
  input: SchemaDiffInput,
  cancellationToken?: SchemaDiffCancellationToken,
  options: SchemaDiffWorkerOptions = {}
): Promise<SchemaDiffResult> {
  if (cancellationToken?.isCancellationRequested) {
    return Promise.reject(new SchemaDiffCancelledError());
  }

  return new Promise((resolve, reject) => {
    const worker = (options.workerFactory ?? createSchemaDiffWorker)();
    let settled = false;
    let cancellationRegistration: { dispose(): void } | undefined;

    const cleanup = (): void => {
      cancellationRegistration?.dispose();
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
    };

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const terminateWorker = (): void => {
      void worker.terminate().catch(() => undefined);
    };

    const settleWithCancellation = (): void => {
      settle(() => {
        terminateWorker();
        reject(new SchemaDiffCancelledError());
      });
    };

    cancellationRegistration = cancellationToken?.onCancellationRequested?.(() => {
      settleWithCancellation();
    });

    worker.once('message', (message) => {
      settle(() => {
        if (isSchemaDiffWorkerSuccessMessage(message)) {
          resolve(message.diff);
          return;
        }

        if (isSchemaDiffWorkerErrorMessage(message)) {
          reject(createWorkerError(message));
          return;
        }

        reject(new Error('Schema diff worker returned an unexpected response.'));
      });
    });

    worker.once('error', (error) => {
      settle(() => {
        reject(error);
      });
    });

    worker.once('exit', (code) => {
      settle(() => {
        if (code === 0) {
          reject(new Error('Schema diff worker exited before returning a result.'));
          return;
        }

        reject(new Error(`Schema diff worker stopped with exit code ${code}.`));
      });
    });

    try {
      worker.postMessage(input);
    } catch (error) {
      settle(() => {
        terminateWorker();
        reject(error);
      });
    }
  });
}

export function diffSchemaSnapshotsInWorker(
  olderSnapshot: SchemaSnapshot,
  newerSnapshot: SchemaSnapshot,
  beforeFields: FileMakerFieldMetadata[],
  afterFields: FileMakerFieldMetadata[],
  cancellationToken?: SchemaDiffCancellationToken,
  options: SchemaDiffWorkerOptions = {}
): Promise<SchemaDiffResult> {
  return diffSchemaFieldsInWorker(
    {
      profileId: newerSnapshot.profileId,
      layout: newerSnapshot.layout,
      olderSnapshotId: olderSnapshot.id,
      newerSnapshotId: newerSnapshot.id,
      beforeFields,
      afterFields
    },
    cancellationToken,
    options
  );
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

function createSchemaDiffWorker(): SchemaDiffWorkerHandle {
  return new Worker(path.join(__dirname, 'schemaDiffWorker.js'));
}

function isSchemaDiffWorkerSuccessMessage(
  message: unknown
): message is Extract<SchemaDiffWorkerMessage, { type: 'success' }> {
  return isRecord(message) && message.type === 'success' && isRecord(message.diff);
}

function isSchemaDiffWorkerErrorMessage(
  message: unknown
): message is Extract<SchemaDiffWorkerMessage, { type: 'error' }> {
  return (
    isRecord(message) &&
    message.type === 'error' &&
    typeof message.message === 'string' &&
    (message.stack === undefined || typeof message.stack === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createWorkerError(message: Extract<SchemaDiffWorkerMessage, { type: 'error' }>): Error {
  const error = new Error(message.message);
  if (message.stack) {
    error.stack = message.stack;
  }

  return error;
}
