import { readFile } from 'fs/promises';

import type * as vscode from 'vscode';

import { FMClient } from './services/fmClient';
import { FmBridgeServer } from './services/fmBridgeServer';
import { SecretStore } from './services/secretStore';
import type { FmWebProjectService } from './services/fmWebProjectService';
import type { Logger } from './services/logger';
import type { ProfileStore } from './services/profileStore';
import type { ConnectionProfile } from './types/fm';

const HEADLESS_PROFILE_ID = 'headless-env';
const DEFAULT_BRIDGE_PORT = 8080;
const BRIDGE_HOST = '0.0.0.0';

export interface HeadlessBridgeConfig {
  port: number;
  serverUrl: string;
  database: string;
  username: string;
  passwordFile: string;
  bridgeToken?: string;
}

export interface StartedHeadlessBridge {
  port: number;
  baseUrl: string;
  bridgeToken: string;
  stop: () => Promise<void>;
}

export function resolveHeadlessBridgeConfig(env: NodeJS.ProcessEnv): HeadlessBridgeConfig {
  return {
    port: parseBridgePort(env.BRIDGE_PORT),
    serverUrl: normalizeServerUrl(readRequiredEnv(env, 'FM_SERVER')),
    database: readRequiredEnv(env, 'FM_DATABASE'),
    username: readRequiredEnv(env, 'FM_USER'),
    passwordFile: readRequiredEnv(env, 'FM_PASS_FILE'),
    bridgeToken: readOptionalEnv(env, 'BRIDGE_TOKEN')
  };
}

export async function startHeadlessBridgeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<StartedHeadlessBridge> {
  const config = resolveHeadlessBridgeConfig(env);
  const password = await readPasswordFile(config.passwordFile);
  const logger = createConsoleLogger();
  const secrets = createMemorySecretStorage();
  const secretStore = new SecretStore(secrets);
  const profile = createHeadlessProfile(config);
  const profileStore = createHeadlessProfileStore(profile);
  const fmClient = new FMClient(secretStore, logger);
  const projectService = createHeadlessProjectService(profile.id);

  await secretStore.setPassword(profile.id, password);

  const bridgeServer = new FmBridgeServer(profileStore, fmClient, projectService, logger, {
    host: BRIDGE_HOST,
    port: config.port,
    allowRemoteClients: true,
    sessionToken: config.bridgeToken
  });
  const started = await bridgeServer.ensureStarted();
  const bridgeToken = bridgeServer.getSessionToken();
  if (!bridgeToken) {
    throw new Error('Headless bridge started without a session token.');
  }

  logger.info('Headless FileMaker bridge started.', {
    port: started.port,
    baseUrl: started.baseUrl,
    tokenSource: config.bridgeToken ? 'BRIDGE_TOKEN' : 'generated'
  });

  if (!config.bridgeToken) {
    logger.info('Generated bridge token for this process.', {
      bridgeToken
    });
  }

  return {
    port: started.port,
    baseUrl: started.baseUrl,
    bridgeToken,
    stop: () => bridgeServer.stop()
  };
}

function parseBridgePort(rawPort: string | undefined): number {
  const value = rawPort?.trim() || String(DEFAULT_BRIDGE_PORT);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('BRIDGE_PORT must be an integer from 1 to 65535.');
  }

  return port;
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = readOptionalEnv(env, name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function readOptionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeServerUrl(rawServerUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawServerUrl);
  } catch {
    throw new Error('FM_SERVER must be a valid http(s) URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('FM_SERVER must use http or https.');
  }

  return rawServerUrl.replace(/\/+$/, '');
}

async function readPasswordFile(passwordFile: string): Promise<string> {
  const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
  if (!password) {
    throw new Error('FM_PASS_FILE must point to a non-empty password file.');
  }

  return password;
}

function createHeadlessProfile(config: HeadlessBridgeConfig): ConnectionProfile {
  return {
    id: HEADLESS_PROFILE_ID,
    name: 'Headless bridge',
    serverUrl: config.serverUrl,
    database: config.database,
    authMode: 'direct',
    username: config.username
  };
}

function createHeadlessProfileStore(profile: ConnectionProfile): ProfileStore {
  const store = {
    getActiveProfileId: () => profile.id,
    getProfile: async (profileId: string) => (profileId === profile.id ? profile : undefined)
  };

  return store as unknown as ProfileStore;
}

function createHeadlessProjectService(profileId: string): FmWebProjectService {
  const service = {
    isWorkspaceTrusted: () => true,
    readProjectConfig: async () => ({
      activeProfileId: profileId
    })
  };

  return service as unknown as FmWebProjectService;
}

function createMemorySecretStorage(): vscode.SecretStorage {
  const values = new Map<string, string>();
  const secrets = {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    }
  };

  return secrets as unknown as vscode.SecretStorage;
}

function createConsoleLogger(): Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: (message: string, metadata?: unknown) => log('debug', message, metadata),
    info: (message: string, metadata?: unknown) => log('info', message, metadata),
    warn: (message: string, metadata?: unknown) => log('warn', message, metadata),
    error: (message: string, metadata?: unknown) => log('error', message, metadata)
  };
}

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  metadata?: unknown
): void {
  const entry = {
    level,
    message,
    ...(metadata && typeof metadata === 'object' ? { metadata } : {})
  };
  const rendered = JSON.stringify(entry);
  if (level === 'error') {
    console.error(rendered);
    return;
  }
  if (level === 'warn') {
    console.warn(rendered);
    return;
  }
  console.log(rendered);
}

if (require.main === module) {
  let startedBridge: StartedHeadlessBridge | undefined;

  const stop = async (): Promise<void> => {
    if (!startedBridge) {
      return;
    }
    await startedBridge.stop();
    startedBridge = undefined;
  };

  startHeadlessBridgeFromEnv()
    .then((started) => {
      startedBridge = started;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to start headless bridge.';
      console.error(JSON.stringify({ level: 'error', message }));
      process.exit(1);
    });

  process.on('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });
}
