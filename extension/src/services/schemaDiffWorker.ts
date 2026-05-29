import { parentPort } from 'node:worker_threads';

import {
  diffSchemaFields,
  type SchemaDiffWorkerMessage,
  type SchemaDiffWorkerRequest
} from './schemaDiff';

const port = parentPort;

if (!port) {
  throw new Error('Schema diff worker must run inside a worker thread.');
}

port.once('message', (request: SchemaDiffWorkerRequest) => {
  try {
    const diff = diffSchemaFields(request);
    postMessage({ type: 'success', diff });
  } catch (error) {
    postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  } finally {
    port.close();
  }
});

function postMessage(message: SchemaDiffWorkerMessage): void {
  port?.postMessage(message);
}
