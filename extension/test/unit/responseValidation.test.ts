import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { FMClientError } from '../../src/services/errors';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from './mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const ok = (response: Record<string, unknown>) => JSON.stringify({ response, messages: [{ code: '0', message: 'OK' }] });
const fmError = (code: string, message = 'x') => JSON.stringify({ response: {}, messages: [{ code, message }] });

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

describe('responses that are not the Data API, redirects, and business errors on 2xx', () => {
  const servers: Server[] = [];

  beforeAll(() => {
    nock.restore();
  });
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function serve(handler: Handler): Promise<{ url: string; requests: string[] }> {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        requests.push(`${request.method} ${request.url}`);
        handler(request, response, body);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
  }

  async function client(url: string) {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    const profile: ConnectionProfile = { id: 'p1', name: 'T', authMode: 'direct', serverUrl: url, database: 'Sales', username: 'u' };
    return { fm: new FMClient(secrets, logger, 3000), profile, secrets };
  }

  const fail = async (action: Promise<unknown>): Promise<FMClientError> => {
    try {
      await action;
    } catch (error) {
      return error as FMClientError;
    }
    throw new Error('expected a failure');
  };

  // Login works; everything else is answered by `onData`.
  const loginThen = (onData: (request: IncomingMessage, response: ServerResponse) => void): Handler => (request, response) => {
    if (request.url?.endsWith('/sessions') && request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json');
      response.end(ok({ token: 'tok' }));
      return;
    }
    onData(request, response);
  };

  describe.each([
    ['an HTML page with status 200', 200, 'text/html', '<html><body>Please sign in</body></html>', /looks like a web page/],
    ['an empty body with status 200', 200, 'application/json', '', /empty response/],
    ['JSON cut off in the middle', 200, 'application/json', '{"response":{"token":', /not valid JSON, or was cut off/],
    ['a JSON array', 200, 'application/json', '[1,2]', /not a Data API response/],
    ['JSON without response and messages', 200, 'application/json', '{"hello":"world"}', /without the Data API/]
  ])('login answered with %s', (_label, status, type, body, wording) => {
    it('raises one clear error, never "Cannot read properties"', async () => {
      const server = await serve((_request, response) => {
        response.statusCode = status;
        response.setHeader('Content-Type', type);
        response.end(body);
      });
      const { fm, profile } = await client(server.url);
      const error = await fail(fm.createSession(profile));
      expect(error.message).toMatch(/did not return Data API JSON/);
      expect(error.message).toMatch(wording);
      expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message).not.toMatch(/Cannot read properties/);
      expect(error.code).toBe('NOT_DATA_API_RESPONSE');
      expect(error.isRetryable).toBe(false);
    });
  });

  it('keeps only a short plain-text start of the page in the details, with the status and content type', async () => {
    const page = `<html><body>${'internal-host '.repeat(100)}</body></html>`;
    const server = await serve((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(page);
    });
    const { fm, profile } = await client(server.url);
    const error = await fail(fm.createSession(profile));
    const details = error.details as { status: number; contentType: string; bodyStart: string };
    expect(details).toMatchObject({ status: 200, contentType: 'text/html' });
    expect(details.bodyStart).not.toContain('<');
    expect(details.bodyStart.length).toBeLessThanOrEqual(201);
  });

  it('a 3xx to a sign-in page on the same server is reported, not followed', async () => {
    const server = await serve((request, response) => {
      if (request.url?.startsWith('/login')) {
        response.end('<html>login</html>');
        return;
      }
      response.statusCode = 302;
      response.setHeader('Location', '/login');
      response.end();
    });
    const { fm, profile } = await client(server.url);
    const error = await fail(fm.createSession(profile));
    expect(error.status).toBe(302);
    expect(error.message).toMatch(/redirected to another path on the same server/);
    expect(server.requests).toHaveLength(1);
  });

  it('a redirect to another origin is not followed, so no login reaches that server', async () => {
    const other = await serve((_request, response) => {
      response.end(ok({ token: 'minted-elsewhere' }));
    });
    const server = await serve((_request, response) => {
      response.statusCode = 307;
      response.setHeader('Location', `${other.url}/fmi/data/vLatest/databases/Sales/sessions`);
      response.end();
    });
    const { fm, profile, secrets } = await client(server.url);
    const error = await fail(fm.createSession(profile));
    expect(error.message).toMatch(/redirected to a different address/);
    expect(error.message).toMatch(/Credentials are not sent there/);
    expect(other.requests).toEqual([]);
    expect(await secrets.getSessionToken('p1')).toBeUndefined();
  });

  it('a 200 whose first message is a FileMaker error is a failure, with that code', async () => {
    const server = await serve((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(fmError('212', 'Invalid user account and/or password'));
    });
    const { fm, profile, secrets } = await client(server.url);
    const error = await fail(fm.createSession(profile));
    expect(error.code).toBe('212');
    expect(error.kind).toBe('auth');
    expect(error.message).toMatch(/\[212\]/);
    expect(await secrets.getSessionToken('p1')).toBeUndefined();
  });

  describe.each([404, 500])('"No records match" (FileMaker code 401) arrives as HTTP %i', (status) => {
    it('is an empty result, so a find and a past-the-end page are not failures', async () => {
      const server = await serve(
        loginThen((_request, response) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.end(fmError('401', 'No records match the request'));
        })
      );
      const { fm, profile } = await client(server.url);
      const result = await fm.findRecords(profile, 'Contacts', { query: [{ Name: 'nobody' }] });
      expect(result).toEqual({ data: [], dataInfo: { foundCount: 0, returnedCount: 0 } });
    });

    it('other FileMaker codes with that status are still errors', async () => {
      const server = await serve(
        loginThen((_request, response) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.end(fmError('105', 'Layout is missing'));
        })
      );
      const { fm, profile } = await client(server.url);
      await expect(fm.findRecords(profile, 'Nope', { query: [{ a: 1 }] })).rejects.toThrow(/\[105\]/);
    });
  });

  it('a find with no FileMaker code on a 404 is an error about the address, not "no records"', async () => {
    const server = await serve(
      loginThen((_request, response) => {
        response.statusCode = 404;
        response.setHeader('Content-Type', 'text/html');
        response.end('<html>Not Found</html>');
      })
    );
    const { fm, profile } = await client(server.url);
    await expect(fm.findRecords(profile, 'Contacts', { query: [{ a: 1 }] })).rejects.toThrow(/Data API is enabled/);
  });

  it('reports a script error that came back with a write that worked', async () => {
    const server = await serve(
      loginThen((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'PATCH') {
          response.end(ok({ modId: '5', scriptError: '3', 'scriptError.presort': '0' }));
        } else if (request.method === 'POST') {
          response.end(ok({ recordId: '9', modId: '0', 'scriptError.prerequest': '104' }));
        } else {
          response.end(ok({ scriptError: '0' }));
        }
      })
    );
    const { fm, profile } = await client(server.url);
    const edited = await fm.editRecord(profile, 'Contacts', '1', { Name: 'x' });
    expect(edited.modId).toBe('5');
    expect(edited.scriptErrors).toEqual([{ phase: 'script', code: '3' }]);
    const created = await fm.createRecord(profile, 'Contacts', { Name: 'y' });
    expect(created.recordId).toBe('9');
    expect(created.scriptErrors).toEqual([{ phase: 'prerequest', code: '104' }]);
    const deleted = await fm.deleteRecord(profile, 'Contacts', '1');
    expect(deleted.scriptErrors).toBeUndefined();
  });
});
