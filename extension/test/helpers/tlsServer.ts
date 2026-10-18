import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { createServer, type Server } from 'https';
import type { AddressInfo } from 'net';

import { keyToPem, type Certificate, type KeyPair } from './x509';

export interface TestTlsServer {
  port: number;
  /** Requests whose HTTP request line arrived (i.e. the TLS handshake was accepted by the client). */
  requests: Array<{ method?: string; url?: string; authorization?: string }>;
  close(): Promise<void>;
}

const JSON_OK = JSON.stringify({ response: { token: 'test-token' }, messages: [{ code: '0', message: 'OK' }] });

/** An https server with the given certificate chain (leaf first) that answers every request like a login. */
export async function startTlsServer(options: {
  key: KeyPair;
  chain: Certificate[];
  body?: string;
}): Promise<TestTlsServer> {
  const requests: TestTlsServer['requests'] = [];
  const server: Server = createServer(
    { key: keyToPem(options.key), cert: options.chain.map((c) => c.pem).join('') },
    (request, response) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      response.setHeader('Content-Type', 'application/json');
      response.end(options.body ?? JSON_OK);
    }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/** A plain-text (http) server, for pointing an https client at the wrong kind of port. */
export async function startPlainServer(onRequest?: (socketDestroy: () => void) => void): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server: HttpServer = createHttpServer((request, response) => {
    if (onRequest) {
      onRequest(() => request.socket.destroy());
      return;
    }
    response.end('plain');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
