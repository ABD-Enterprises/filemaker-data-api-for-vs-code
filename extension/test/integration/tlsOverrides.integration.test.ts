import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer, type Server } from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

let server: Server | undefined;
const hasOpenSsl = canCreateSelfSignedCertificate();

interface LocalhostCertificate {
  key: string;
  cert: string;
}

function createProfile(serverUrl: string, overrides?: Partial<ConnectionProfile>): ConnectionProfile {
  return {
    id: 'tls-profile',
    name: 'TLS Profile',
    authMode: 'direct',
    serverUrl,
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest',
    ...overrides
  };
}

async function createClient() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  await secretStore.setPassword('tls-profile', 'password123');
  return new FMClient(secretStore, logger, 5_000);
}

async function startFileMakerServer(): Promise<string> {
  const certificate = createLocalhostCertificate();
  server = createServer(certificate, (request, response) => {
    request.resume();

    if (
      request.method === 'POST' &&
      request.url === '/fmi/data/vLatest/databases/TestDB/sessions'
    ) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          response: { token: 'tls-token' },
          messages: [{ code: '0', message: 'OK' }]
        })
      );
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ messages: [{ code: '404', message: 'Not found' }] }));
  });

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, 'localhost', () => {
      server?.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return `https://localhost:${address.port}`;
}

function createLocalhostCertificate(): LocalhostCertificate {
  const root = mkdtempSync(join(tmpdir(), 'fm-tls-'));
  const keyPath = join(root, 'key.pem');
  const certPath = join(root, 'cert.pem');

  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '3650',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost'
      ],
      { stdio: 'ignore' }
    );

    return {
      key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8')
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function closeServer(): Promise<void> {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server = undefined;
}

const describeWithOpenSsl = hasOpenSsl ? describe : describe.skip;

describeWithOpenSsl('FMClient TLS overrides', () => {
  beforeEach(() => {
    nock.enableNetConnect((host) => host.startsWith('localhost:'));
  });

  afterEach(async () => {
    await closeServer();
    nock.disableNetConnect();
  });

  it('creates a session against a self-signed HTTPS server when allowSelfSigned is true', async () => {
    const serverUrl = await startFileMakerServer();
    const client = await createClient();

    await expect(
      client.createSession(createProfile(serverUrl, { allowSelfSigned: true }))
    ).resolves.toBe('tls-token');
  });

  it('fails with the original TLS certificate error when verification remains enabled', async () => {
    const serverUrl = await startFileMakerServer();
    const client = await createClient();

    await expect(client.createSession(createProfile(serverUrl))).rejects.toThrow(
      /self-signed|certificate/i
    );
  });
});

function canCreateSelfSignedCertificate(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
