import { randomUUID } from 'crypto';

import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';

import type {
  ConnectionProfile,
  ContainerUploadFile,
  EditRecordResult,
  FileMakerRecord,
  FindRecordsRequest,
  FindRecordsResult,
  RequestHistoryRecorder,
  RequestMetricsRecorder,
  RunScriptRequest,
  RunScriptResult
} from '../types/fm';
import type {
  DataApiEnvelope,
  DataApiListLayoutsResponse,
  DataApiListRecordsResponse,
  DataApiListScriptsResponse,
  DataApiSessionResponse
} from '../types/dataApi';
import { isProxyProfile } from '../types/fm';
import type { Logger } from './logger';
import type { SecretStore } from './secretStore';
import { ProxyClient } from './proxyClient';
import { FMClientError, toFMClientError } from './errors';
import { normalizeError } from '../utils/normalizeError';
import { buildProfileCacheKey, cacheKeyMatchesProfile } from '../utils/profileCacheKey';
import { redactString } from '../utils/redact';
import { extractLayoutNames } from '../utils/layoutParser';
import { extractScriptNames } from '../utils/scriptParser';
import { SessionTokenTracker } from './session/sessionTokenTracker';
import { createHttpsAgentForProfile } from './tlsAgent';

interface LayoutCacheEntry {
  expiresAt: number;
  layouts: string[];
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  data?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

interface HistoryContext {
  profileId: string;
  operation: string;
  layout?: string;
  endpoint: string;
}

interface RequestTrace {
  requestId: string;
  reauthCount: number;
  cacheHit: boolean;
  endpoint: string;
}

interface ClientRequestControl {
  signal?: AbortSignal;
}

export interface FMClientContainerUploadOptions {
  signal?: AbortSignal;
  fieldRepetition?: number;
  modId?: string;
  maxBytes?: number;
}

const DEFAULT_LAYOUT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_MAX_AGE_MS = 14 * 60 * 1000; // 14 minutes; FM Data API tokens expire at 15
const DEFAULT_SESSION_REFRESH_LEAD_MS = 30 * 1000; // refresh 30s before nominal expiry

export interface FMClientSessionOptions {
  /** Treat the session token as expired after this many ms since issuance. Default 14m. */
  maxAgeMs?: number;
  /** Refresh proactively when remaining lifetime drops below this many ms. Default 30s. */
  refreshLeadMs?: number;
  /** Override Date.now for tests. */
  now?: () => number;
}

export class FMClient {
  private readonly httpClient: AxiosInstance;
  private readonly proxyClient: ProxyClient;
  private readonly layoutCache = new Map<string, LayoutCacheEntry>();
  private readonly layoutMetadataCache = new Map<string, Record<string, unknown>>();
  private readonly layoutMetadataEtags = new Map<string, string>();
  private readonly sessionTracker: SessionTokenTracker;
  private readonly inFlightRefresh = new Map<string, Promise<string>>();
  private readonly timeoutMs: number;
  private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  private readonly getSessionMaxAgeMs: () => number;
  private readonly getSessionRefreshLeadMs: () => number;
  private readonly now: () => number;

  public constructor(
    private readonly secretStore: SecretStore,
    logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    timeoutMs?: number,
    httpClient?: AxiosInstance,
    proxyClient?: ProxyClient,
    private readonly historyRecorder?: RequestHistoryRecorder,
    private readonly metricsRecorder?: RequestMetricsRecorder,
    sessionOptions?: FMClientSessionOptions | (() => FMClientSessionOptions)
  ) {
    this.logger = logger;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.httpClient = httpClient ?? axios.create({ timeout: this.timeoutMs });
    this.proxyClient =
      proxyClient ?? new ProxyClient(this.secretStore, this.logger, this.timeoutMs, this.httpClient);

    const resolveOptions = (): FMClientSessionOptions => {
      if (typeof sessionOptions === 'function') {
        return sessionOptions() ?? {};
      }
      return sessionOptions ?? {};
    };

    this.getSessionMaxAgeMs = () => resolveOptions().maxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS;
    this.getSessionRefreshLeadMs = () =>
      resolveOptions().refreshLeadMs ?? DEFAULT_SESSION_REFRESH_LEAD_MS;
    this.now = () => resolveOptions().now?.() ?? Date.now();
    this.sessionTracker = new SessionTokenTracker({
      defaultMaxAgeMs: DEFAULT_SESSION_MAX_AGE_MS,
      defaultRefreshLeadMs: DEFAULT_SESSION_REFRESH_LEAD_MS
    });
  }

  /**
   * Visible for testing. Returns true if the in-memory issuance window indicates the token needs refresh.
   *
   * Behavior:
   * - If `refreshLeadMs` is 0, proactive timed refresh is disabled (rely on 401-retry only).
   * - If `issuedAt` is unknown (e.g., extension restart), reuse the persisted token instead of forcing
   *   refresh — the 401-retry path handles real expiry.
   * - Clock skew (negative ageMs) is treated as 0 to prevent extending lifetime via clock jumps.
   * - If `refreshLeadMs >= maxAgeMs`, lifetime is clamped to maxAgeMs to avoid infinite refresh loops.
   */
  public shouldRefreshSession(profileId: string, now = this.now()): boolean {
    return this.sessionTracker.shouldRefresh(profileId, {
      now,
      maxAgeMs: this.getSessionMaxAgeMs(),
      refreshLeadMs: this.getSessionRefreshLeadMs()
    });
  }

  public async createSession(profile: ConnectionProfile, control?: ClientRequestControl): Promise<string> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'createSession',
        endpoint: 'POST /sessions'
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          const token = await this.proxyClient.createSession(profile, control?.signal);
          const normalizedToken = token ?? 'proxy-session';
          await this.secretStore.setSessionToken(profile.id, normalizedToken);
          this.sessionTracker.markIssued(profile.id, this.now());
          this.invalidateProfileCache(profile.id);
          return normalizedToken;
        }

        const username = profile.username?.trim();
        if (!username) {
          throw new FMClientError('Direct auth mode requires a username in the connection profile.');
        }

        const password = await this.secretStore.getPassword(profile.id);
        if (!password) {
          throw new FMClientError(
            'No password found for profile. Edit the connection profile to set a password.'
          );
        }

        const basic = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');

        try {
          const envelope = await this.requestNoAuth<DataApiSessionResponse>(profile, {
            method: 'POST',
            path: '/sessions',
            headers: {
              Authorization: `Basic ${basic}`
            },
            data: {},
            signal: control?.signal
          });
          trace.endpoint = 'POST /sessions';

          const token = envelope.response.token;
          if (!token) {
            throw new FMClientError(
              'FileMaker create session response did not include a session token.',
              {
                details: envelope
              }
            );
          }

          await this.secretStore.setSessionToken(profile.id, token);
          this.sessionTracker.markIssued(profile.id, this.now());
          this.invalidateProfileCache(profile.id);

          return token;
        } catch (error) {
          throw toFMClientError(
            normalizeError(error, {
              fallbackMessage: 'Failed to create FileMaker session.',
              requestId: trace.requestId,
              endpoint: 'POST /sessions'
            })
          );
        }
      }
    );
  }

  public async deleteSession(profile: ConnectionProfile, control?: ClientRequestControl): Promise<void> {
    await this.withHistory(
      {
        profileId: profile.id,
        operation: 'deleteSession',
        endpoint: 'DELETE /sessions/{token}'
      },
      async (trace) => {
        const token = await this.secretStore.getSessionToken(profile.id);

        if (!token) {
          return;
        }

        try {
          if (isProxyProfile(profile)) {
            await this.proxyClient.deleteSession(profile, control?.signal);
          } else {
            // Use the existing token directly. Without skipProactiveRefresh, an in-flight
            // refresh window during disconnect could create a new session, then this DELETE
            // would target the old token while authenticating with the new one — orphaning
            // the new server-side session.
            await this.requestWithAuth<Record<string, unknown>>(
              profile,
              {
                method: 'DELETE',
                path: `/sessions/${encodeURIComponent(token)}`,
                signal: control?.signal
              },
              false,
              trace,
              { skipProactiveRefresh: true }
            );
          }
        } catch (error) {
          this.logger.warn('Failed to delete session cleanly during disconnect.', {
            profileId: profile.id,
            error
          });
        } finally {
          await this.secretStore.deleteSessionToken(profile.id);
          this.sessionTracker.clear(profile.id);
          this.invalidateProfileCache(profile.id);
        }
      }
    );
  }

  public async listLayouts(profile: ConnectionProfile, control?: ClientRequestControl): Promise<string[]> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'listLayouts',
        endpoint: 'GET /layouts'
      },
      async (trace) => {
        const cacheKey = this.buildProfileCacheKey(profile);
        const cached = this.layoutCache.get(cacheKey);
        const now = Date.now();

        if (cached && cached.expiresAt > now) {
          trace.cacheHit = true;
          return cached.layouts;
        }

        if (isProxyProfile(profile)) {
          const layouts = await this.proxyClient.listLayouts(profile, control?.signal);
          this.layoutCache.set(cacheKey, {
            layouts,
            expiresAt: now + DEFAULT_LAYOUT_TTL_MS
          });
          return layouts;
        }

        const envelope = await this.requestWithAuth<DataApiListLayoutsResponse>(
          profile,
          {
            method: 'GET',
            path: '/layouts',
            signal: control?.signal
          },
          true,
          trace
        );

        const layouts = extractLayoutNames(envelope.response.layouts ?? []);

        this.layoutCache.set(cacheKey, {
          layouts,
          expiresAt: now + DEFAULT_LAYOUT_TTL_MS
        });

        return layouts;
      }
    );
  }

  public async listScripts(profile: ConnectionProfile, control?: ClientRequestControl): Promise<string[]> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'listScripts',
        endpoint: 'GET /scripts'
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.listScripts(profile, control?.signal);
        }

        const envelope = await this.requestWithAuth<DataApiListScriptsResponse>(
          profile,
          {
            method: 'GET',
            path: '/scripts',
            signal: control?.signal
          },
          true,
          trace
        );

        return extractScriptNames(envelope.response.scripts ?? []);
      }
    );
  }

  public async getRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    control?: ClientRequestControl
  ): Promise<FileMakerRecord> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'getRecord',
        layout,
        endpoint: `GET /layouts/${layout}/records/${recordId}`
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.getRecord(profile, layout, recordId, control?.signal);
        }

        const envelope = await this.requestWithAuth<DataApiListRecordsResponse>(
          profile,
          {
            method: 'GET',
            path: `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
            signal: control?.signal
          },
          true,
          trace
        );

        const record = envelope.response.data?.[0];
        if (!record) {
          throw new FMClientError('Record not found in FileMaker response payload.', {
            details: envelope
          });
        }

        return record;
      }
    );
  }

  public async findRecords(
    profile: ConnectionProfile,
    layout: string,
    body: FindRecordsRequest,
    control?: ClientRequestControl
  ): Promise<FindRecordsResult> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'findRecords',
        layout,
        endpoint: `POST /layouts/${layout}/_find`
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.findRecords(profile, layout, body, control?.signal);
        }

        const payload: Record<string, unknown> = {
          query: body.query
        };

        if (body.sort && body.sort.length > 0) {
          payload.sort = body.sort;
        }

        if (typeof body.limit === 'number') {
          payload.limit = body.limit;
        }

        if (typeof body.offset === 'number') {
          payload.offset = body.offset;
        }

        const envelope = await this.requestWithAuth<DataApiListRecordsResponse>(
          profile,
          {
            method: 'POST',
            path: `/layouts/${encodeURIComponent(layout)}/_find`,
            data: payload,
            signal: control?.signal
          },
          true,
          trace
        );

        return {
          data: envelope.response.data ?? [],
          dataInfo: envelope.response.dataInfo
        };
      }
    );
  }

  public async getLayoutMetadata(
    profile: ConnectionProfile,
    layout: string,
    control?: ClientRequestControl
  ): Promise<Record<string, unknown>> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'getLayoutMetadata',
        layout,
        endpoint: `GET /layouts/${layout}`
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.getLayoutMetadata(profile, layout, control?.signal);
        }

        const metadataKey = this.buildLayoutMetadataCacheKey(profile, layout);
        const cachedMetadata = this.layoutMetadataCache.get(metadataKey);
        const etag = this.layoutMetadataEtags.get(metadataKey);
        const response = await this.requestWithAuthRaw<Record<string, unknown>>(
          profile,
          {
            method: 'GET',
            path: `/layouts/${encodeURIComponent(layout)}`,
            headers: etag
              ? {
                  'If-None-Match': etag
                }
              : undefined,
            signal: control?.signal
          },
          true,
          trace
        );

        if (response.status === 304 && cachedMetadata) {
          trace.cacheHit = true;
          return cachedMetadata;
        }

        if (!response.envelope) {
          throw new FMClientError('Layout metadata response payload is empty.');
        }

        const nextEtag = response.headers['etag'];
        if (typeof nextEtag === 'string' && nextEtag.length > 0) {
          this.layoutMetadataEtags.set(metadataKey, nextEtag);
        }

        this.layoutMetadataCache.set(metadataKey, response.envelope.response);

        return response.envelope.response;
      }
    );
  }

  public async editRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    fieldDataPartial: Record<string, unknown>,
    control?: ClientRequestControl
  ): Promise<EditRecordResult> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'editRecord',
        layout,
        endpoint: `PATCH /layouts/${layout}/records/${recordId}`
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.editRecord(
            profile,
            layout,
            recordId,
            fieldDataPartial,
            control?.signal
          );
        }

        if (Object.keys(fieldDataPartial).length === 0) {
          throw new FMClientError('At least one field change is required to edit a record.');
        }

        const envelope = await this.requestWithAuth<Record<string, unknown>>(
          profile,
          {
            method: 'PATCH',
            path: `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
            data: {
              fieldData: fieldDataPartial
            },
            signal: control?.signal
          },
          true,
          trace
        );

        const modIdValue = envelope.response.modId;

        return {
          recordId,
          modId:
            typeof modIdValue === 'string'
              ? modIdValue
              : typeof modIdValue === 'number'
                ? String(modIdValue)
                : undefined,
          messages: envelope.messages,
          response: envelope.response
        };
      }
    );
  }

  public async createRecord(
    profile: ConnectionProfile,
    layout: string,
    fieldData: Record<string, unknown>,
    control?: ClientRequestControl
  ): Promise<EditRecordResult> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'createRecord',
        layout,
        endpoint: `POST /layouts/${layout}/records`
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.createRecord(profile, layout, fieldData, control?.signal);
        }

        const envelope = await this.requestWithAuth<Record<string, unknown>>(
          profile,
          {
            method: 'POST',
            path: `/layouts/${encodeURIComponent(layout)}/records`,
            data: {
              fieldData
            },
            signal: control?.signal
          },
          true,
          trace
        );

        const recordIdValue = envelope.response.recordId;
        const recordId =
          typeof recordIdValue === 'string'
            ? recordIdValue
            : typeof recordIdValue === 'number'
              ? String(recordIdValue)
              : undefined;

        if (!recordId) {
          throw new FMClientError('FileMaker createRecord response did not include recordId.', {
            details: envelope.response
          });
        }

        const modIdValue = envelope.response.modId;
        return {
          recordId,
          modId:
            typeof modIdValue === 'string'
              ? modIdValue
              : typeof modIdValue === 'number'
                ? String(modIdValue)
                : undefined,
          messages: envelope.messages,
          response: envelope.response
        };
      }
    );
  }

  public async deleteRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    control?: ClientRequestControl
  ): Promise<EditRecordResult> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'deleteRecord',
        layout,
        endpoint: `DELETE /layouts/${layout}/records/${recordId}`
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.deleteRecord(profile, layout, recordId, control?.signal);
        }

        const envelope = await this.requestWithAuth<Record<string, unknown>>(
          profile,
          {
            method: 'DELETE',
            path: `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
            signal: control?.signal
          },
          true,
          trace
        );

        const modIdValue = envelope.response.modId;
        return {
          recordId,
          modId:
            typeof modIdValue === 'string'
              ? modIdValue
              : typeof modIdValue === 'number'
                ? String(modIdValue)
                : undefined,
          messages: envelope.messages,
          response: envelope.response
        };
      }
    );
  }

  public async uploadContainer(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    fieldName: string,
    file: ContainerUploadFile,
    options?: FMClientContainerUploadOptions
  ): Promise<EditRecordResult> {
    const normalizedLayout = layout.trim();
    const normalizedRecordId = recordId.trim();
    const normalizedFieldName = fieldName.trim();
    const normalizedFileName = file.fileName.trim();
    const content = normalizeUploadContent(file.content);

    if (!normalizedLayout) {
      throw new FMClientError('Layout is required to upload container data.');
    }
    if (!normalizedRecordId) {
      throw new FMClientError('Record ID is required to upload container data.');
    }
    if (!normalizedFieldName) {
      throw new FMClientError('Container field name is required.');
    }
    if (!normalizedFileName) {
      throw new FMClientError('Upload file name is required.');
    }
    if (content.byteLength === 0) {
      throw new FMClientError('Upload file is empty.');
    }
    if (options?.maxBytes !== undefined && content.byteLength > options.maxBytes) {
      throw new FMClientError(
        `Container upload exceeds the configured limit (${content.byteLength} > ${options.maxBytes} bytes).`,
        {
          code: 'CONTAINER_UPLOAD_TOO_LARGE',
          details: {
            actualBytes: content.byteLength,
            maxBytes: options.maxBytes
          }
        }
      );
    }

    const fieldRepetition = normalizeContainerFieldRepetition(options?.fieldRepetition);
    const uploadFile = {
      ...file,
      fileName: normalizedFileName,
      content
    };

    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'uploadContainer',
        layout: normalizedLayout,
        endpoint: `POST /layouts/${normalizedLayout}/records/${normalizedRecordId}/containers/${normalizedFieldName}/${fieldRepetition}`
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.uploadContainer(
            profile,
            normalizedLayout,
            normalizedRecordId,
            normalizedFieldName,
            uploadFile,
            {
              fieldRepetition,
              modId: options?.modId,
              signal: options?.signal
            }
          );
        }

        const multipart = buildContainerUploadMultipart(uploadFile);
        const envelope = await this.requestWithAuth<Record<string, unknown>>(
          profile,
          {
            method: 'POST',
            path:
              `/layouts/${encodeURIComponent(normalizedLayout)}` +
              `/records/${encodeURIComponent(normalizedRecordId)}` +
              `/containers/${encodeURIComponent(normalizedFieldName)}/${fieldRepetition}`,
            data: multipart.body,
            headers: {
              'Content-Type': multipart.contentType,
              'Content-Length': String(multipart.body.byteLength)
            },
            params: options?.modId ? { modId: options.modId } : undefined,
            signal: options?.signal
          },
          true,
          trace
        );

        return {
          recordId: normalizedRecordId,
          messages: envelope.messages,
          response: envelope.response
        };
      }
    );
  }

  public async runScript(
    profile: ConnectionProfile,
    request: RunScriptRequest,
    control?: ClientRequestControl
  ): Promise<RunScriptResult> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'runScript',
        layout: request.layout,
        endpoint: `POST /layouts/${request.layout}/script/${request.scriptName}`
      },
      async (trace) => {
        if (isProxyProfile(profile)) {
          return this.proxyClient.runScript(profile, request, control?.signal);
        }

        const scriptName = request.scriptName.trim();
        if (!scriptName) {
          throw new FMClientError('Script name is required.');
        }

        const layout = request.layout.trim();
        if (!layout) {
          throw new FMClientError('Layout is required to run script.');
        }

        try {
          const envelope = await this.requestWithAuth<Record<string, unknown>>(
            profile,
            {
              method: 'POST',
              path: `/layouts/${encodeURIComponent(layout)}/script/${encodeURIComponent(scriptName)}`,
              data: {
                scriptParam: request.scriptParam,
                recordId: request.recordId
              },
              signal: control?.signal
            },
            true,
            trace
          );

          return {
            response: envelope.response,
            messages: envelope.messages
          };
        } catch (error) {
          if (!isLikelyScriptUnsupportedError(error)) {
            throw toFMClientError(
              normalizeError(error, {
                fallbackMessage: 'Failed to run FileMaker script.',
                requestId: trace.requestId,
                endpoint: `POST /layouts/${request.layout}/script/${request.scriptName}`
              })
            );
          }
        }

        try {
          const params = buildScriptParams(scriptName, request.scriptParam);

          const fallbackEnvelope = request.recordId
            ? await this.requestWithAuth<Record<string, unknown>>(profile, {
                method: 'GET',
                path: `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(request.recordId)}`,
                params,
                signal: control?.signal
              }, true, trace)
            : await this.requestWithAuth<Record<string, unknown>>(profile, {
                method: 'POST',
                path: `/layouts/${encodeURIComponent(layout)}/_find`,
                data: {
                  query: [{}],
                  limit: 1
                },
                params,
                signal: control?.signal
              }, true, trace);

          return {
            response: fallbackEnvelope.response,
            messages: fallbackEnvelope.messages
          };
        } catch (error) {
          if (isLikelyScriptUnsupportedError(error)) {
            throw new FMClientError('Script runner is not supported on this server/profile.', {
              code: 'SCRIPT_UNSUPPORTED',
              status: getErrorStatus(error),
              details: error
            });
          }

          throw toFMClientError(
            normalizeError(error, {
              fallbackMessage: 'Failed to run FileMaker script.',
              requestId: trace.requestId,
              endpoint: request.recordId
                ? `GET /layouts/${request.layout}/records/${request.recordId}`
                : `POST /layouts/${request.layout}/_find`
            })
          );
        }
      }
    );
  }

  public invalidateProfileCache(profileId: string): void {
    for (const key of this.layoutCache.keys()) {
      if (cacheKeyMatchesProfile(key, profileId)) {
        this.layoutCache.delete(key);
      }
    }

    for (const key of this.layoutMetadataCache.keys()) {
      if (cacheKeyMatchesProfile(key, profileId)) {
        this.layoutMetadataCache.delete(key);
      }
    }

    for (const key of this.layoutMetadataEtags.keys()) {
      if (cacheKeyMatchesProfile(key, profileId)) {
        this.layoutMetadataEtags.delete(key);
      }
    }
  }

  private async ensureSessionToken(
    profile: ConnectionProfile,
    control?: ClientRequestControl,
    options?: { skipProactiveRefresh?: boolean }
  ): Promise<string> {
    const existing = await this.secretStore.getSessionToken(profile.id);

    // Allow callers (e.g., deleteSession) to opt out of proactive refresh so they can use
    // the existing token rather than creating a new session that gets orphaned on the server.
    const skipProactive = options?.skipProactiveRefresh === true;

    if (existing && (skipProactive || !this.shouldRefreshSession(profile.id))) {
      return existing;
    }

    if (!existing && skipProactive) {
      // Fall through to createSession — there's no token to delete.
    }

    // Per-profile mutex to coalesce concurrent refreshes. Without this, parallel requests
    // each call createSession, creating multiple FM sessions where only the last persisted
    // token is reused — orphaning the rest until server timeout.
    const inFlight = this.inFlightRefresh.get(profile.id);
    if (inFlight) {
      return inFlight;
    }

    if (existing) {
      this.logger.debug('Proactively refreshing session token before request.', {
        profileId: profile.id
      });
    }

    const refreshPromise = this.createSession(profile, control).finally(() => {
      this.inFlightRefresh.delete(profile.id);
    });

    this.inFlightRefresh.set(profile.id, refreshPromise);

    return refreshPromise;
  }

  private async requestWithAuth<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions,
    retryOn401 = true,
    trace?: RequestTrace,
    authOptions?: { skipProactiveRefresh?: boolean }
  ): Promise<DataApiEnvelope<TResponse>> {
    if (trace) {
      trace.endpoint = `${request.method} ${request.path}`;
    }

    const token = await this.ensureSessionToken(profile, { signal: request.signal }, authOptions);

    try {
      const config: AxiosRequestConfig = {
        method: request.method,
        url: this.buildEndpoint(profile, request.path),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(request.headers ?? {})
        },
        data: request.data,
        params: request.params,
        signal: request.signal,
        timeout: this.timeoutMs,
        maxBodyLength: Infinity,
        httpsAgent: createHttpsAgentForProfile(profile)
      };

      const response = await this.httpClient.request<DataApiEnvelope<TResponse>>(config);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 401 && retryOn401) {
        if (trace) {
          trace.reauthCount += 1;
        }
        this.logger.info('Session token rejected; refreshing token and retrying once.', {
          profileId: profile.id,
          requestId: trace?.requestId
        });
        await this.secretStore.deleteSessionToken(profile.id);
        this.sessionTracker.clear(profile.id);
        await this.createSession(profile, { signal: request.signal });

        return this.requestWithAuth(profile, request, false, trace);
      }

      throw toFMClientError(
        normalizeError(error, {
          fallbackMessage: `FileMaker request failed (${request.method} ${request.path}).`,
          requestId: trace?.requestId,
          endpoint: `${request.method} ${request.path}`
        })
      );
    }
  }

  private async requestWithAuthRaw<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions,
    retryOn401 = true,
    trace?: RequestTrace
  ): Promise<{
    status: number;
    headers: Record<string, string | undefined>;
    envelope?: DataApiEnvelope<TResponse>;
  }> {
    if (trace) {
      trace.endpoint = `${request.method} ${request.path}`;
    }

    const token = await this.ensureSessionToken(profile, { signal: request.signal });

    try {
      const config: AxiosRequestConfig = {
        method: request.method,
        url: this.buildEndpoint(profile, request.path),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(request.headers ?? {})
        },
        data: request.data,
        params: request.params,
        signal: request.signal,
        timeout: this.timeoutMs,
        maxBodyLength: Infinity,
        httpsAgent: createHttpsAgentForProfile(profile),
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304
      };

      const response = await this.httpClient.request<DataApiEnvelope<TResponse>>(config);
      const headers = normalizeHeaders(response.headers as Record<string, unknown>);
      if (response.status === 304) {
        return {
          status: response.status,
          headers
        };
      }

      return {
        status: response.status,
        headers,
        envelope: response.data
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 401 && retryOn401) {
        if (trace) {
          trace.reauthCount += 1;
        }
        this.logger.info('Session token rejected; refreshing token and retrying once.', {
          profileId: profile.id,
          requestId: trace?.requestId
        });
        await this.secretStore.deleteSessionToken(profile.id);
        this.sessionTracker.clear(profile.id);
        await this.createSession(profile, { signal: request.signal });

        return this.requestWithAuthRaw(profile, request, false, trace);
      }

      throw toFMClientError(
        normalizeError(error, {
          fallbackMessage: `FileMaker request failed (${request.method} ${request.path}).`,
          requestId: trace?.requestId,
          endpoint: `${request.method} ${request.path}`
        })
      );
    }
  }

  private async requestNoAuth<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions
  ): Promise<DataApiEnvelope<TResponse>> {
    const config: AxiosRequestConfig = {
      method: request.method,
      url: this.buildEndpoint(profile, request.path),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(request.headers ?? {})
      },
      data: request.data,
      params: request.params,
      signal: request.signal,
      timeout: this.timeoutMs,
      httpsAgent: createHttpsAgentForProfile(profile)
    };

    const response = await this.httpClient.request<DataApiEnvelope<TResponse>>(config);
    return response.data;
  }

  private buildProfileCacheKey(profile: ConnectionProfile): string {
    return buildProfileCacheKey(profile);
  }

  private buildLayoutMetadataCacheKey(profile: ConnectionProfile, layout: string): string {
    return buildProfileCacheKey(profile, layout);
  }

  private buildEndpoint(profile: ConnectionProfile, path: string): string {
    const normalizedServer = profile.serverUrl.replace(/\/+$/, '');
    const normalizedBasePath = this.normalizePath(profile.apiBasePath ?? '/fmi/data');
    const version = (profile.apiVersionPath ?? 'vLatest').replace(/^\/+|\/+$/g, '');
    const database = encodeURIComponent(profile.database);

    return `${normalizedServer}${normalizedBasePath}/${version}/databases/${database}${path}`;
  }

  private normalizePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed.startsWith('/')) {
      return `/${trimmed.replace(/\/+$/, '')}`;
    }

    return trimmed.replace(/\/+$/, '');
  }

  private async withHistory<T>(
    context: HistoryContext,
    execute: (trace: RequestTrace) => Promise<T>
  ): Promise<T> {
    const trace: RequestTrace = {
      requestId: randomUUID(),
      reauthCount: 0,
      cacheHit: false,
      endpoint: context.endpoint
    };

    const start = Date.now();
    this.logger.debug('FileMaker request started.', {
      requestId: trace.requestId,
      operation: context.operation,
      endpoint: trace.endpoint,
      profileId: context.profileId
    });

    try {
      const result = await execute(trace);
      this.logger.debug('FileMaker request completed.', {
        requestId: trace.requestId,
        operation: context.operation,
        endpoint: trace.endpoint,
        durationMs: Date.now() - start,
        reauthCount: trace.reauthCount,
        cacheHit: trace.cacheHit
      });
      await this.recordHistory({
        requestId: trace.requestId,
        profileId: context.profileId,
        layout: context.layout,
        operation: context.operation,
        durationMs: Date.now() - start,
        success: true
      });
      await this.recordMetrics({
        requestId: trace.requestId,
        profileId: context.profileId,
        operation: context.operation,
        endpoint: trace.endpoint,
        durationMs: Date.now() - start,
        success: true,
        reauthCount: trace.reauthCount,
        cacheHit: trace.cacheHit
      });
      return result;
    } catch (error) {
      this.logger.warn('FileMaker request failed.', {
        requestId: trace.requestId,
        operation: context.operation,
        endpoint: trace.endpoint,
        durationMs: Date.now() - start,
        reauthCount: trace.reauthCount,
        cacheHit: trace.cacheHit,
        error
      });
      await this.recordHistory({
        requestId: trace.requestId,
        profileId: context.profileId,
        layout: context.layout,
        operation: context.operation,
        durationMs: Date.now() - start,
        success: false,
        httpStatus: getErrorStatus(error),
        message: getErrorMessage(error)
      });
      await this.recordMetrics({
        requestId: trace.requestId,
        profileId: context.profileId,
        operation: context.operation,
        endpoint: trace.endpoint,
        durationMs: Date.now() - start,
        success: false,
        httpStatus: getErrorStatus(error),
        reauthCount: trace.reauthCount,
        cacheHit: trace.cacheHit
      });

      throw error;
    }
  }

  private async recordHistory(entry: {
    requestId?: string;
    profileId: string;
    layout?: string;
    operation: string;
    durationMs: number;
    success: boolean;
    httpStatus?: number;
    message?: string;
  }): Promise<void> {
    if (!this.historyRecorder) {
      return;
    }

    try {
      await this.historyRecorder.record(entry);
    } catch (error) {
      this.logger.warn('Failed to persist request history entry.', { error });
    }
  }

  private async recordMetrics(entry: {
    requestId: string;
    profileId: string;
    operation: string;
    endpoint: string;
    durationMs: number;
    success: boolean;
    httpStatus?: number;
    reauthCount: number;
    cacheHit: boolean;
  }): Promise<void> {
    if (!this.metricsRecorder) {
      return;
    }

    try {
      await this.metricsRecorder.record(entry);
    } catch (error) {
      this.logger.warn('Failed to persist request metrics entry.', { error });
    }
  }
}

function buildScriptParams(
  scriptName: string,
  scriptParam?: string
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    script: scriptName
  };

  if (scriptParam !== undefined && scriptParam.length > 0) {
    params['script.param'] = scriptParam;
  }

  return params;
}

function normalizeUploadContent(content: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function normalizeContainerFieldRepetition(fieldRepetition: number | undefined): number {
  if (fieldRepetition === undefined) {
    return 1;
  }

  if (!Number.isInteger(fieldRepetition) || fieldRepetition < 1) {
    throw new FMClientError('Container field repetition must be a positive integer.');
  }

  return fieldRepetition;
}

function buildContainerUploadMultipart(file: ContainerUploadFile & { content: Buffer }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----filemaker-data-api-tools-${randomUUID()}`;
  const contentType = sanitizeMultipartHeaderValue(file.contentType ?? 'application/octet-stream');
  const fileName = sanitizeMultipartHeaderValue(file.fileName);

  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="upload"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    body: Buffer.concat([header, file.content, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function sanitizeMultipartHeaderValue(value: string): string {
  const normalized = value
    .replace(/[\r\n"]/g, '_')
    .replace(/\\/g, '\\\\')
    .trim();
  return normalized.length > 0 ? normalized : 'application/octet-stream';
}

function isLikelyScriptUnsupportedError(error: unknown): boolean {
  const status = getErrorStatus(error);

  return status === 404 || status === 405 || status === 501;
}

function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof FMClientError) {
    return error.status;
  }

  const axiosError = error as AxiosError;
  if (axiosError?.isAxiosError) {
    return axiosError.response?.status;
  }

  return undefined;
}

function getErrorMessage(error: unknown): string | undefined {
  const normalized = normalizeError(error);
  return redactString(normalized.message);
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[key.toLowerCase()] = value;
      continue;
    }

    if (Array.isArray(value) && typeof value[0] === 'string') {
      normalized[key.toLowerCase()] = value[0];
      continue;
    }

    normalized[key.toLowerCase()] = undefined;
  }

  return normalized;
}
