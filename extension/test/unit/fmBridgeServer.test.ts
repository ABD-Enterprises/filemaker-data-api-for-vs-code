import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionProfile, FindRecordsResult, RunScriptResult } from '../../src/types/fm';
import { FmBridgeServer } from '../../src/services/fmBridgeServer';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Local Profile',
  serverUrl: 'https://example.com',
  database: 'AppDB',
  authMode: 'direct',
  username: 'dev'
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

describe('FmBridgeServer', () => {
  it('handles runScript requests through FMClient', async () => {
    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub({
        runScript: vi.fn(async () => ({
          response: { scriptResult: 'ok' },
          messages: [{ code: '0', message: 'OK' }]
        }))
      }),
      createFmWebProjectServiceStub(),
      logger
    );

    const response = await invokeBridgeRequest(server, '/fm/runScript', {
      origin: 'http://localhost:3000',
      payload: {
        layout: 'Contacts',
        scriptName: 'Run_Web_Action',
        scriptParam: 'id=42'
      }
    });

    expect(response.status).toBe(200);
    const body = response.json as RunScriptResult;
    expect(body.response).toEqual({ scriptResult: 'ok' });
  });

  it('rejects disallowed origins', async () => {
    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub(),
      createFmWebProjectServiceStub(),
      logger
    );

    const response = await invokeBridgeRequest(server, '/fm/find', {
      origin: 'https://evil.example',
      payload: {
        layout: 'Contacts',
        query: [{}]
      }
    });

    expect(response.status).toBe(403);
    const body = response.json as { error: string };
    expect(body.error).toContain('Origin');
  });

  it('serves health checks without bridge token authentication', async () => {
    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub(),
      createFmWebProjectServiceStub(),
      logger
    );

    const response = await invokeBridgeRequest(server, '/healthz', {
      method: 'GET'
    });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: 'ok' });
  });

  it('permits remote clients only when explicitly configured', async () => {
    const defaultServer = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub(),
      createFmWebProjectServiceStub(),
      logger
    );

    const defaultResponse = await invokeBridgeRequest(defaultServer, '/fm/find', {
      remoteAddress: '172.17.0.1',
      payload: {
        layout: 'Contacts',
        query: [{}]
      }
    });

    const headlessServer = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub(),
      createFmWebProjectServiceStub(),
      logger,
      {
        allowRemoteClients: true
      }
    );

    const headlessResponse = await invokeBridgeRequest(headlessServer, '/fm/find', {
      remoteAddress: '172.17.0.1',
      payload: {
        layout: 'Contacts',
        query: [{}]
      }
    });

    expect(defaultResponse.status).toBe(403);
    expect(headlessResponse.status).toBe(200);
  });

  it('returns timeout/abort failures from route handlers', async () => {
    const findRecords = vi.fn(
      async (
        _profile: ConnectionProfile,
        _layout: string,
        _request: unknown,
        control?: { signal?: AbortSignal }
      ) =>
        new Promise<FindRecordsResult>((_resolve, reject) => {
          control?.signal?.addEventListener('abort', () => reject(new Error('Request timed out.')));
        })
    );

    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub({
        findRecords
      }),
      createFmWebProjectServiceStub(),
      logger
    );

    const response = await invokeBridgeRequest(server, '/fm/find', {
      origin: 'http://localhost:3000',
      payload: {
        layout: 'Contacts',
        query: [{}],
        timeoutMs: 10
      }
    });

    expect(response.status).toBe(500);
    const body = response.json as { error: string };
    expect(body.error).toContain('timed out');
    expect(findRecords).toHaveBeenCalledTimes(1);
  });
});

async function invokeBridgeRequest(
  server: FmBridgeServer,
  route: string,
  input: {
    method?: string;
    origin?: string;
    payload?: Record<string, unknown>;
    remoteAddress?: string;
  }
): Promise<{ status: number; body: string; json: unknown; headers: Record<string, string> }> {
  const request = buildRequest(
    route,
    input.method,
    input.origin,
    input.payload,
    input.remoteAddress
  );
  const response = buildResponse();

  const bridge = server as unknown as {
    handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  };
  await bridge.handleRequest(request, response.response);

  let json: unknown = {};
  if (response.body.trim().length > 0) {
    json = JSON.parse(response.body) as unknown;
  }

  return {
    status: response.status,
    body: response.body,
    json,
    headers: response.headers
  };
}

function buildRequest(
  route: string,
  method: string | undefined,
  origin: string | undefined,
  payload: Record<string, unknown> | undefined,
  remoteAddress = '127.0.0.1'
): IncomingMessage {
  const readable = new Readable({
    read() {}
  }) as IncomingMessage;

  readable.method = method ?? 'POST';
  readable.url = route;
  readable.headers = {
    'content-type': 'application/json',
    ...(origin ? { origin } : {})
  };
  (readable as IncomingMessage & { socket: { remoteAddress?: string } }).socket = {
    remoteAddress
  } as IncomingMessage['socket'];

  readable.push(JSON.stringify(payload ?? {}));
  readable.push(null);
  return readable;
}

function buildResponse(): {
  response: ServerResponse;
  status: number;
  body: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  let status = 200;
  let body = '';
  let headersSent = false;

  const response = {
    get statusCode() {
      return status;
    },
    set statusCode(value: number) {
      status = value;
    },
    get headersSent() {
      return headersSent;
    },
    setHeader(name: string, value: number | string | readonly string[]) {
      const rendered = Array.isArray(value) ? value.join(', ') : String(value);
      headers[name.toLowerCase()] = rendered;
      return this as unknown as ServerResponse;
    },
    end(chunk?: string | Buffer) {
      headersSent = true;
      if (chunk) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      return this as unknown as ServerResponse;
    }
  } as unknown as ServerResponse;

  return {
    response,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    headers
  };
}

function createProfileStoreStub(): {
  getActiveProfileId: () => string | undefined;
  getProfile: (profileId: string) => Promise<ConnectionProfile | undefined>;
} {
  return {
    getActiveProfileId: () => profile.id,
    getProfile: vi.fn(async (profileId: string) => (profileId === profile.id ? profile : undefined))
  };
}

function createFmClientStub(overrides?: {
  findRecords?: (
    profile: ConnectionProfile,
    layout: string,
    request: unknown,
    control?: { signal?: AbortSignal }
  ) => Promise<FindRecordsResult>;
  getRecord?: (
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    control?: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>;
  editRecord?: (
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    fieldData: Record<string, unknown>,
    control?: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>;
  createRecord?: (
    profile: ConnectionProfile,
    layout: string,
    fieldData: Record<string, unknown>,
    control?: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>;
  deleteRecord?: (
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    control?: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>;
  runScript?: (
    profile: ConnectionProfile,
    request: {
      layout: string;
      scriptName: string;
      scriptParam?: string;
      recordId?: string;
    },
    control?: { signal?: AbortSignal }
  ) => Promise<RunScriptResult>;
}): {
  findRecords: (
    profile: ConnectionProfile,
    layout: string,
    request: unknown,
    control?: { signal?: AbortSignal }
  ) => Promise<FindRecordsResult>;
  getRecord: (
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    control?: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>;
  editRecord: (
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    fieldData: Record<string, unknown>,
    control?: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>;
  createRecord: (
    profile: ConnectionProfile,
    layout: string,
    fieldData: Record<string, unknown>,
    control?: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>;
  deleteRecord: (
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    control?: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>;
  runScript: (
    profile: ConnectionProfile,
    request: {
      layout: string;
      scriptName: string;
      scriptParam?: string;
      recordId?: string;
    },
    control?: { signal?: AbortSignal }
  ) => Promise<RunScriptResult>;
} {
  return {
    findRecords:
      overrides?.findRecords ??
      (vi.fn(async () => ({
        data: []
      })) as unknown as (
        profile: ConnectionProfile,
        layout: string,
        request: unknown,
        control?: { signal?: AbortSignal }
      ) => Promise<FindRecordsResult>),
    getRecord:
      overrides?.getRecord ??
      (vi.fn(async () => ({
        recordId: '1',
        fieldData: {}
      })) as unknown as (
        profile: ConnectionProfile,
        layout: string,
        recordId: string,
        control?: { signal?: AbortSignal }
      ) => Promise<Record<string, unknown>>),
    editRecord:
      overrides?.editRecord ??
      (vi.fn(async () => ({
        recordId: '1',
        response: {}
      })) as unknown as (
        profile: ConnectionProfile,
        layout: string,
        recordId: string,
        fieldData: Record<string, unknown>,
        control?: { signal?: AbortSignal }
      ) => Promise<Record<string, unknown>>),
    createRecord:
      overrides?.createRecord ??
      (vi.fn(async () => ({
        recordId: '1',
        response: {}
      })) as unknown as (
        profile: ConnectionProfile,
        layout: string,
        fieldData: Record<string, unknown>,
        control?: { signal?: AbortSignal }
      ) => Promise<Record<string, unknown>>),
    deleteRecord:
      overrides?.deleteRecord ??
      (vi.fn(async () => ({
        recordId: '1',
        response: {}
      })) as unknown as (
        profile: ConnectionProfile,
        layout: string,
        recordId: string,
        control?: { signal?: AbortSignal }
      ) => Promise<Record<string, unknown>>),
    runScript:
      overrides?.runScript ??
      (vi.fn(async () => ({
        response: {},
        messages: []
      })) as unknown as (
        profile: ConnectionProfile,
        request: {
          layout: string;
          scriptName: string;
          scriptParam?: string;
          recordId?: string;
        },
        control?: { signal?: AbortSignal }
      ) => Promise<RunScriptResult>)
  };
}

function createFmWebProjectServiceStub(): {
  isWorkspaceTrusted: () => boolean;
  readProjectConfig: () => Promise<{ activeProfileId?: string }>;
} {
  return {
    isWorkspaceTrusted: () => true,
    readProjectConfig: vi.fn(async () => ({
      activeProfileId: profile.id
    }))
  };
}
