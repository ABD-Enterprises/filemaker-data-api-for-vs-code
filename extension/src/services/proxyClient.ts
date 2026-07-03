import axios, { type AxiosInstance } from 'axios';

import type { Logger } from './logger';
import { FMClientError, toFMClientError } from './errors';
import type { SecretStore } from './secretStore';
import type {
  ConnectionProfile,
  ContainerUploadFile,
  EditRecordResult,
  FileMakerRecord,
  FindRecordsRequest,
  FindRecordsResult,
  RunScriptRequest,
  RunScriptResult
} from '../types/fm';
import { extractLayoutNames } from '../utils/layoutParser';
import { extractScriptNames } from '../utils/scriptParser';
import { normalizeError } from '../utils/normalizeError';
import { redactValue } from '../utils/redact';
import { createHttpsAgentForProfile } from './tlsAgent';

interface ProxyEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: unknown;
}

interface ProxySessionResponse {
  token?: string;
}

interface ProxyListLayoutsResponse {
  layouts?: unknown;
}

interface ProxyListScriptsResponse {
  scripts?: unknown;
}

interface ProxyGetRecordResponse {
  record?: FileMakerRecord;
}

interface ProxyFindResponse {
  result?: FindRecordsResult;
}

interface ProxyRunScriptResponse {
  result?: RunScriptResult;
}

interface ProxyEditRecordResponse {
  result?: EditRecordResult;
}

interface ProxyCreateRecordResponse {
  result?: EditRecordResult;
}

interface ProxyDeleteRecordResponse {
  result?: EditRecordResult;
}

interface ProxyUploadContainerResponse {
  result?: EditRecordResult;
}

export interface ProxyUploadContainerOptions {
  signal?: AbortSignal;
  fieldRepetition?: number;
  modId?: string;
}

export class ProxyClient {
  private readonly httpClient: AxiosInstance;
  private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

  public constructor(
    private readonly secretStore: SecretStore,
    logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    timeoutMs: number,
    httpClient?: AxiosInstance
  ) {
    this.logger = logger;
    this.httpClient = httpClient ?? axios.create({ timeout: timeoutMs });
  }

  public async createSession(
    profile: ConnectionProfile,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const data = await this.invoke<ProxySessionResponse>(profile, 'createSession', {}, signal);
    return data.token;
  }

  public async deleteSession(profile: ConnectionProfile, signal?: AbortSignal): Promise<void> {
    await this.invoke<unknown>(profile, 'deleteSession', {}, signal);
  }

  public async listLayouts(profile: ConnectionProfile, signal?: AbortSignal): Promise<string[]> {
    const data = await this.invoke<ProxyListLayoutsResponse>(profile, 'listLayouts', {}, signal);
    return extractLayoutNames(data.layouts ?? []);
  }

  public async listScripts(profile: ConnectionProfile, signal?: AbortSignal): Promise<string[]> {
    const data = await this.invoke<ProxyListScriptsResponse>(profile, 'listScripts', {}, signal);
    return extractScriptNames(data.scripts ?? []);
  }

  public async getRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    signal?: AbortSignal
  ): Promise<FileMakerRecord> {
    const data = await this.invoke<ProxyGetRecordResponse>(
      profile,
      'getRecord',
      { layout, recordId },
      signal
    );

    if (!data.record) {
      throw new FMClientError('Proxy response did not include a record object.');
    }

    return data.record;
  }

  public async findRecords(
    profile: ConnectionProfile,
    layout: string,
    body: FindRecordsRequest,
    signal?: AbortSignal
  ): Promise<FindRecordsResult> {
    const data = await this.invoke<ProxyFindResponse>(profile, 'findRecords', { layout, body }, signal);

    if (!data.result) {
      throw new FMClientError('Proxy response did not include a find result payload.');
    }

    return data.result;
  }

  public async getLayoutMetadata(
    profile: ConnectionProfile,
    layout: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.invoke<Record<string, unknown>>(profile, 'getLayoutMetadata', { layout }, signal);
  }

  public async runScript(
    profile: ConnectionProfile,
    request: RunScriptRequest,
    signal?: AbortSignal
  ): Promise<RunScriptResult> {
    const data = await this.invoke<ProxyRunScriptResponse>(
      profile,
      'runScript',
      request as unknown as Record<string, unknown>,
      signal
    );

    if (!data.result) {
      throw new FMClientError('Proxy response did not include a runScript result payload.');
    }

    return data.result;
  }

  public async editRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    fieldDataPartial: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<EditRecordResult> {
    const data = await this.invoke<ProxyEditRecordResponse>(profile, 'editRecord', {
      layout,
      recordId,
      fieldData: fieldDataPartial
    }, signal);

    if (!data.result) {
      throw new FMClientError('Proxy response did not include an editRecord result payload.');
    }

    return data.result;
  }

  public async createRecord(
    profile: ConnectionProfile,
    layout: string,
    fieldData: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<EditRecordResult> {
    const data = await this.invoke<ProxyCreateRecordResponse>(
      profile,
      'createRecord',
      {
        layout,
        fieldData
      },
      signal
    );

    if (!data.result) {
      throw new FMClientError('Proxy response did not include a createRecord result payload.');
    }

    return data.result;
  }

  public async deleteRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    signal?: AbortSignal
  ): Promise<EditRecordResult> {
    const data = await this.invoke<ProxyDeleteRecordResponse>(
      profile,
      'deleteRecord',
      {
        layout,
        recordId
      },
      signal
    );

    if (!data.result) {
      throw new FMClientError('Proxy response did not include a deleteRecord result payload.');
    }

    return data.result;
  }

  public async uploadContainer(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    fieldName: string,
    file: ContainerUploadFile,
    options?: ProxyUploadContainerOptions
  ): Promise<EditRecordResult> {
    const data = await this.invoke<ProxyUploadContainerResponse>(
      profile,
      'uploadContainer',
      {
        layout,
        recordId,
        fieldName,
        fieldRepetition: options?.fieldRepetition ?? 1,
        modId: options?.modId,
        fileName: file.fileName,
        contentType: file.contentType ?? 'application/octet-stream',
        contentBase64: Buffer.from(file.content).toString('base64')
      },
      options?.signal
    );

    if (!data.result) {
      throw new FMClientError('Proxy response did not include an uploadContainer result payload.');
    }

    return data.result;
  }

  private async invoke<T>(
    profile: ConnectionProfile,
    action: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const endpoint = profile.proxyEndpoint?.trim();
    if (!endpoint) {
      throw new FMClientError('Proxy mode requires a proxy endpoint on the profile.');
    }

    const apiKey = await this.secretStore.getProxyApiKey(profile.id);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // Trust model: the proxy receives the minimum fields it needs to authenticate
    // against FileMaker on the user's behalf. A compromised proxy has the same
    // FileMaker access as the configured profile. See docs/security.md for the
    // full threat model. The `name` and full server/path metadata are intentionally
    // omitted — proxies are configured per-environment and don't need to display
    // human-readable profile names.
    try {
      const response = await this.httpClient.post<ProxyEnvelope<T> | T>(
        endpoint,
        {
          action,
          profile: buildProxyProfilePayload(profile),
          payload
        },
        {
          headers,
          signal,
          httpsAgent: createHttpsAgentForProfile(profile)
        }
      );

      const responseData = response.data;
      if (this.isProxyEnvelope(responseData)) {
        if (responseData.ok === false) {
          throw new FMClientError(responseData.error ?? responseData.message ?? 'Proxy request failed.', {
            details: responseData.details
          });
        }

        if (responseData.data === undefined) {
          throw new FMClientError('Proxy response envelope did not include a data field.');
        }

        return responseData.data;
      }

      return responseData as T;
    } catch (error) {
      if (error instanceof FMClientError) {
        throw error;
      }

      throw this.normalizeProxyError(error);
    }
  }

  private isProxyEnvelope<T>(value: unknown): value is ProxyEnvelope<T> {
    if (!value || typeof value !== 'object') {
      return false;
    }

    return 'ok' in value || 'data' in value || 'error' in value;
  }

  private normalizeProxyError(error: unknown): FMClientError {
    const normalized = normalizeError(error, {
      fallbackMessage: 'Proxy request failed.'
    });

    this.logger.error('Proxy request error', {
      kind: normalized.kind,
      status: normalized.status,
      message: normalized.message,
      details: redactValue(normalized.details)
    });

    return toFMClientError(normalized);
  }
}

/**
 * Payload sent to the proxy on every action.
 *
 * Includes only the fields the proxy needs to route + authenticate against
 * FileMaker. The human-readable `name` is intentionally omitted: proxies are
 * configured per-environment and identify profiles by `id`. Trimming the
 * payload reduces what a compromised proxy sees in its logs.
 *
 * Exported for testing.
 */
export interface ProxyProfilePayload {
  id: string;
  database: string;
  serverUrl: string;
  apiBasePath?: string;
  apiVersionPath?: string;
}

export function buildProxyProfilePayload(profile: ConnectionProfile): ProxyProfilePayload {
  const payload: ProxyProfilePayload = {
    id: profile.id,
    database: profile.database,
    serverUrl: profile.serverUrl
  };
  if (profile.apiBasePath !== undefined) {
    payload.apiBasePath = profile.apiBasePath;
  }
  if (profile.apiVersionPath !== undefined) {
    payload.apiVersionPath = profile.apiVersionPath;
  }
  return payload;
}
