import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  diffSchemaFields,
  diffSchemaFieldsInWorker,
  SchemaDiffCancelledError,
  type SchemaDiffCancellationToken,
  type SchemaDiffWorkerHandle,
  type SchemaDiffWorkerRequest
} from '../../src/services/schemaDiff';

describe('schemaDiff', () => {
  it('detects added, removed, and changed fields', () => {
    const diff = diffSchemaFields({
      profileId: 'profile-a',
      layout: 'Contacts',
      beforeFields: [
        { name: 'FirstName', type: 'text', repetitions: 1 },
        { name: 'LegacyCode', type: 'text', repetitions: 1 }
      ],
      afterFields: [
        { name: 'FirstName', type: 'number', repetitions: 1 },
        { name: 'LastName', type: 'text', repetitions: 1 }
      ]
    });

    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(diff.added.map((field) => field.name)).toEqual(['LastName']);
    expect(diff.removed.map((field) => field.name)).toEqual(['LegacyCode']);
    const changed = diff.changed.at(0);
    expect(changed?.fieldName).toBe('FirstName');
    expect(changed?.changes.some((change) => change.attribute === 'type')).toBe(true);
    expect(diff.hasChanges).toBe(true);
  });

  it('returns no changes when metadata is equivalent', () => {
    const diff = diffSchemaFields({
      profileId: 'profile-a',
      layout: 'Contacts',
      beforeFields: [{ name: 'FirstName', type: 'text', repetitions: 1 }],
      afterFields: [{ name: 'FirstName', type: 'text', repetitions: 1 }]
    });

    expect(diff.hasChanges).toBe(false);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('posts schema diff input to a worker and resolves the worker result', async () => {
    const worker = new FakeSchemaDiffWorker();
    const input: SchemaDiffWorkerRequest = {
      profileId: 'profile-a',
      layout: 'Contacts',
      beforeFields: [{ name: 'FirstName', type: 'text' }],
      afterFields: [{ name: 'FirstName', type: 'text' }]
    };
    const diff = diffSchemaFields(input);

    const result = diffSchemaFieldsInWorker(input, undefined, {
      workerFactory: () => worker
    });

    expect(worker.messages).toEqual([input]);

    worker.emit('message', {
      type: 'success',
      diff
    });

    await expect(result).resolves.toEqual(diff);
  });

  it('terminates the worker when schema diff cancellation is requested', async () => {
    const worker = new FakeSchemaDiffWorker();
    const cancellation = createCancellationToken();
    const input: SchemaDiffWorkerRequest = {
      profileId: 'profile-a',
      layout: 'Contacts',
      beforeFields: [{ name: 'FirstName', type: 'text' }],
      afterFields: [{ name: 'FirstName', type: 'number' }]
    };

    const result = diffSchemaFieldsInWorker(input, cancellation.token, {
      workerFactory: () => worker
    });

    cancellation.cancel();

    await expect(result).rejects.toBeInstanceOf(SchemaDiffCancelledError);
    expect(worker.terminated).toBe(true);
  });
});

class FakeSchemaDiffWorker extends EventEmitter implements SchemaDiffWorkerHandle {
  public readonly messages: SchemaDiffWorkerRequest[] = [];
  public terminated = false;

  public postMessage(value: SchemaDiffWorkerRequest): void {
    this.messages.push(value);
  }

  public terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }
}

function createCancellationToken(): {
  token: SchemaDiffCancellationToken;
  cancel: () => void;
} {
  let listener: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (callback: () => void) => {
      listener = callback;
      return {
        dispose: () => {
          listener = undefined;
        }
      };
    }
  };

  return {
    token,
    cancel: () => {
      token.isCancellationRequested = true;
      listener?.();
    }
  };
}
