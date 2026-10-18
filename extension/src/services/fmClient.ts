import { createHash, randomUUID } from 'crypto';

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
import { isCredentialRejection } from '../utils/fileMakerCodes';
import { redactString } from '../utils/redact';
import { extractLayoutNames } from '../utils/layoutParser';
import { extractScriptNames } from '../utils/scriptParser';
import { SessionTokenTracker } from './session/sessionTokenTracker';
import { createHttpsAgentForProfile } from './tlsAgent';
import { NOT_DATA_API_CODE, extractScriptErrors, parseDataApiEnvelope } from './responseGuard';

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
  /** Refuse a response body larger than this (axios maxContentLength). */
  maxResponseBytes?: number;
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
  /**
   * The user asked for this sign-in (Connect, Test Connection). It goes ahead even when automatic
   * sign-ins are paused after the server rejected the stored credentials, and its result ends or
   * renews that pause.
   */
  userInitiated?: boolean;
  /** For list, get and find calls: refuse a response body larger than this many bytes. */
  maxResponseBytes?: number;
}

export interface FMClientContainerUploadOptions {
  signal?: AbortSignal;
  fieldRepetition?: number;
  modId?: string;
  maxBytes?: number;
}

/** Longest wait between automatic sign-in attempts after FileMaker reports no free sessions (956). */
const MAX_SESSION_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const FIRST_SESSION_LIMIT_BACKOFF_MS = 30 * 1000;

interface AuthPause {
  code: string;
  /** Hash of the account, password and server the rejection was for; a change ends the pause. */
  stamp: string;
}

/** What the extension knows about a connection right now, from its most recent requests. */
export interface SessionHealth {
  state: 'connecting' | 'connected' | 'auth-failed' | 'certificate' | 'unreachable';
  /** The error message behind a failed state (already safe to show). */
  message?: string;
  at: number;
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

/** Optional guards for an edit. */
export interface EditRecordOptions {
  /** The record's modification id as loaded; the edit is refused if the record has changed since. */
  modId?: string;
}

/** FileMaker reports "no records match the request" as error code 401 (seen as HTTP 404 or 500). */
/** `{ scriptErrors }` to spread into a result, or nothing when no script reported an error. */
function scriptErrorsOf(response: unknown): { scriptErrors?: ReturnType<typeof extractScriptErrors> } {
  const scriptErrors = extractScriptErrors(response);
  return scriptErrors.length > 0 ? { scriptErrors } : {};
}

function credentialStamp(profile: ConnectionProfile, username: string, password: string): string {
  return createHash('sha256')
    .update([profile.serverUrl, profile.database, username, password].join('\u0000'))
    .digest('hex');
}

function isNoRecordsFound(error: unknown): boolean {
  // Matched on FileMaker's own code, whatever the HTTP status: Claris documents business errors as
  // HTTP 500 and says nothing about 404 for this case, and servers differ.
  return error instanceof FMClientError && error.code === '401';
}

export class FMClient {
  private readonly httpClient: AxiosInstance;
  private readonly proxyClient: ProxyClient;
  private readonly layoutCache = new Map<string, LayoutCacheEntry>();
  private readonly layoutMetadataCache = new Map<string, Record<string, unknown>>();
  private readonly layoutMetadataEtags = new Map<string, string>();
  private readonly sessionTracker: SessionTokenTracker;
  private readonly inFlightRefresh = new Map<string, Promise<string>>();
  private readonly health = new Map<string, SessionHealth>();
  private readonly invalidationListeners = new Set<(profileId: string) => void>();
  private readonly healthListeners = new Set<(profileId: string, health: SessionHealth | undefined) => void>();
  /**
   * Profiles whose stored credentials FileMaker rejected (210, 211, 212, 213, 214). Automatic
   * sign-ins stop for them: trying again with the same password cannot work and repeated failures
   * can lock the account. The pause ends when the account, password or server changes, or when the
   * user runs Connect / Test Connection.
   */
  private readonly authPauses = new Map<string, AuthPause>();
  /** Profiles told "no free sessions" (956): automatic sign-ins wait, with growing delays. */
  private readonly sessionLimitBackoff = new Map<string, { until: number; attempts: number }>();
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
        if (this.health.get(profile.id)?.state !== 'connected') {
          this.setHealth(profile.id, { state: 'connecting', at: this.now() });
        }
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

        const stamp = credentialStamp(profile, username, password);
        if (control?.userInitiated !== true) {
          this.assertAutomaticSignInAllowed(profile, stamp);
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
          this.authPauses.delete(profile.id);
          this.sessionLimitBackoff.delete(profile.id);

          return token;
        } catch (error) {
          const failure = toFMClientError(
            normalizeError(error, {
              fallbackMessage: 'Failed to create FileMaker session.',
              requestId: trace.requestId,
              endpoint: 'POST /sessions'
            })
          );
          this.recordSignInFailure(profile, stamp, failure);
          throw failure;
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
            signal: control?.signal,
            maxResponseBytes: control?.maxResponseBytes
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
            signal: control?.signal,
            maxResponseBytes: control?.maxResponseBytes
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
            signal: control?.signal,
            maxResponseBytes: control?.maxResponseBytes
          },
          true,
          trace
        );

        const getScriptErrors = extractScriptErrors(envelope.response);
        if (getScriptErrors.length > 0) {
          this.logger.warn('A script reported an error while reading a record.', {
            layout,
            scriptErrors: getScriptErrors
          });
        }

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

        let envelope: DataApiEnvelope<DataApiListRecordsResponse>;
        try {
          envelope = await this.requestWithAuth<DataApiListRecordsResponse>(
            profile,
            {
              method: 'POST',
              path: `/layouts/${encodeURIComponent(layout)}/_find`,
              data: payload,
              signal: control?.signal,
              maxResponseBytes: control?.maxResponseBytes
            },
            true,
            trace
          );
        } catch (error) {
          // FileMaker answers a find with no matches (or an offset past the last match)
          // with HTTP 404 and error 401, not an empty list. That is a result, not a failure.
          if (isNoRecordsFound(error)) {
            return { data: [], dataInfo: { foundCount: 0, returnedCount: 0 } };
          }
          throw error;
        }

        return {
          data: envelope.response.data ?? [],
          dataInfo: envelope.response.dataInfo,
          ...scriptErrorsOf(envelope.response)
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
    control?: ClientRequestControl,
    options?: EditRecordOptions
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
            control?.signal,
            options?.modId
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
              fieldData: fieldDataPartial,
              // When given, FileMaker refuses the edit (error 306) if the record changed since this modId.
              ...(options?.modId !== undefined ? { modId: options.modId } : {})
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
          response: envelope.response,
          ...scriptErrorsOf(envelope.response)
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
          response: envelope.response,
          ...scriptErrorsOf(envelope.response)
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
          response: envelope.response,
          ...scriptErrorsOf(envelope.response)
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
          response: envelope.response,
          ...scriptErrorsOf(envelope.response)
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

  /**
   * Step one of Test Connection: `GET /fmi/data/<version>/productInfo` needs no account and no
   * database, so it separates "cannot reach the Data API" (TLS, DNS, port, a web page, Data API
   * off) from everything about the account. Returns the product name and version.
   */
  public async getProductInfo(
    profile: ConnectionProfile,
    control?: ClientRequestControl
  ): Promise<{ name?: string; version?: string }> {
    const envelope = await this.requestServerLevel<{ productInfo?: Record<string, unknown> }>(
      profile,
      '/productInfo',
      control,
      'Failed to reach the FileMaker Data API.'
    );
    const info = envelope.response.productInfo ?? {};
    return {
      name: typeof info.name === 'string' ? info.name : undefined,
      version: typeof info.version === 'string' ? info.version : undefined
    };
  }

  /**
   * Step two: `GET /fmi/data/<version>/databases`. Without credentials FileMaker lists the hosted
   * databases unless "Filter Databases in Client Applications" is on, in which case it answers
   * 401 and the list is unavailable until sign-in (returned as `undefined`).
   */
  public async listHostedDatabases(
    profile: ConnectionProfile,
    control?: ClientRequestControl
  ): Promise<string[] | undefined> {
    try {
      const envelope = await this.requestServerLevel<{ databases?: Array<{ name?: unknown }> }>(
        profile,
        '/databases',
        control,
        'Failed to list the hosted databases.'
      );
      return (envelope.response.databases ?? [])
        .map((entry) => (typeof entry?.name === 'string' ? entry.name : undefined))
        .filter((name): name is string => Boolean(name));
    } catch (error) {
      if (error instanceof FMClientError && (error.status === 401 || error.status === 403)) {
        return undefined;
      }
      throw error;
    }
  }

  private async requestServerLevel<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    path: string,
    control: ClientRequestControl | undefined,
    fallbackMessage: string
  ): Promise<DataApiEnvelope<TResponse>> {
    const base = profile.serverUrl.replace(/\/+$/, '');
    const basePath = this.normalizePath(profile.apiBasePath ?? '/fmi/data');
    const version = (profile.apiVersionPath ?? 'vLatest').replace(/^\/+|\/+$/g, '');
    try {
      const response = await this.httpClient.request<unknown>({
        method: 'GET',
        url: `${base}${basePath}/${version}${path}`,
        headers: { Accept: 'application/json' },
        signal: control?.signal,
        timeout: this.timeoutMs,
        maxRedirects: 0,
        httpsAgent: createHttpsAgentForProfile(profile)
      });
      return parseDataApiEnvelope<TResponse>(response);
    } catch (error) {
      throw toFMClientError(normalizeError(error, { fallbackMessage, endpoint: `GET ${path}` }));
    }
  }

  /**
   * Calls `listener` whenever the cached data of a profile is dropped: a new sign-in (the account may
   * have changed, and with it the layouts and fields it can see), a sign-out, or a profile edit.
   * Other caches built on this client (the schema cache) use it to drop theirs too.
   */
  public onProfileInvalidated(listener: (profileId: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  public invalidateProfileCache(profileId: string): void {
    for (const listener of this.invalidationListeners) {
      try {
        listener(profileId);
      } catch (error) {
        this.logger.warn('A cache invalidation listener failed.', { error });
      }
    }
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

  /** The last known health of a profile's connection, or undefined before any request this session. */
  public getHealth(profileId: string): SessionHealth | undefined {
    return this.health.get(profileId);
  }

  /** Calls `listener` whenever a profile's health changes. Returns a function that stops it. */
  public onHealthChange(listener: (profileId: string, health: SessionHealth | undefined) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  private setHealth(profileId: string, next: SessionHealth | undefined): void {
    const before = this.health.get(profileId);
    if (next) {
      this.health.set(profileId, next);
    } else {
      this.health.delete(profileId);
    }
    if (before?.state !== next?.state || before?.message !== next?.message) {
      for (const listener of this.healthListeners) {
        try {
          listener(profileId, next);
        } catch (error) {
          this.logger.warn('A health listener failed.', { error });
        }
      }
    }
  }

  /** What a failed request says about the connection; FileMaker business errors say it is fine. */
  private healthAfterFailure(error: unknown): SessionHealth {
    const at = this.now();
    if (error instanceof FMClientError) {
      if (error.kind === 'certificate') {
        return { state: 'certificate', message: error.message, at };
      }
      if (error.fmCategory === 'credentials' || error.kind === 'auth' && error.fmCategory !== 'privilege') {
        return { state: 'auth-failed', message: error.message, at };
      }
      if (error.networkCode || error.kind === 'network' || error.kind === 'timeout') {
        return { state: 'unreachable', message: error.message, at };
      }
      if (error.code === 'NOT_DATA_API_RESPONSE' || (error.status === 404 && error.code === undefined)) {
        return { state: 'unreachable', message: error.message, at };
      }
    }
    // An answer from FileMaker (a missing layout, a refused write) proves the connection works.
    return { state: 'connected', at };
  }

  /** Ends a pause on automatic sign-ins now (the credentials were just edited). */
  public clearAuthPause(profileId: string): void {
    this.authPauses.delete(profileId);
    this.sessionLimitBackoff.delete(profileId);
  }

  /** True while automatic sign-ins are paused for this profile because FileMaker rejected its credentials. */
  public isSignInPaused(profileId: string): boolean {
    return this.authPauses.has(profileId);
  }

  private assertAutomaticSignInAllowed(profile: ConnectionProfile, stamp: string): void {
    const pause = this.authPauses.get(profile.id);
    if (pause) {
      if (pause.stamp !== stamp) {
        this.authPauses.delete(profile.id);
      } else {
        throw new FMClientError(
          `Sign-in is paused: FileMaker rejected the saved credentials (error ${pause.code}) and the extension will not try again on its own, so repeated attempts cannot lock the account. Edit the connection to fix the account or password, or run "FileMaker: Connect".`,
          {
            code: pause.code,
            kind: 'auth',
            fmCategory: 'credentials',
            isRetryable: false,
            details: { signInPaused: true }
          }
        );
      }
    }

    const wait = this.sessionLimitBackoff.get(profile.id);
    if (wait && wait.until > this.now()) {
      const seconds = Math.ceil((wait.until - this.now()) / 1000);
      throw new FMClientError(
        `FileMaker has no free Data API sessions. Waiting ${seconds} s before signing in again (run "FileMaker: Connect" to try now), or ask the administrator to disconnect idle clients.`,
        { code: '956', kind: 'server', fmCategory: 'transient', isRetryable: true, details: { retryAfterMs: wait.until - this.now() } }
      );
    }
  }

  private recordSignInFailure(profile: ConnectionProfile, stamp: string, failure: FMClientError): void {
    if (isCredentialRejection(failure.code)) {
      this.authPauses.set(profile.id, { code: failure.code as string, stamp });
      this.logger.warn('FileMaker rejected the stored credentials; automatic sign-ins are paused for this profile.', {
        profileId: profile.id,
        code: failure.code
      });
    } else if (failure.code === '956') {
      const attempts = (this.sessionLimitBackoff.get(profile.id)?.attempts ?? 0) + 1;
      const delay = Math.min(FIRST_SESSION_LIMIT_BACKOFF_MS * 2 ** (attempts - 1), MAX_SESSION_LIMIT_BACKOFF_MS);
      this.sessionLimitBackoff.set(profile.id, { until: this.now() + delay, attempts });
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

  /**
   * Replaces a session token the server rejected. Parallel requests that all hit the
   * expired token share one renewal: a request that finds a newer token already stored
   * just retries with it, and one that finds a renewal under way waits for it. Without
   * this, N parallel requests would open N sessions and leave N-1 orphaned on the server.
   */
  private async renewRejectedSession(
    profile: ConnectionProfile,
    rejectedToken: string,
    control?: ClientRequestControl
  ): Promise<void> {
    const current = await this.secretStore.getSessionToken(profile.id);
    if (current && current !== rejectedToken) {
      return;
    }

    const inFlight = this.inFlightRefresh.get(profile.id);
    if (inFlight) {
      await inFlight;
      return;
    }

    // Registered synchronously (no await between the check above and the set below),
    // so concurrent callers resuming after their own awaits see it.
    const renewal = (async () => {
      await this.secretStore.deleteSessionToken(profile.id);
      this.sessionTracker.clear(profile.id);
      return this.createSession(profile, control);
    })().finally(() => {
      this.inFlightRefresh.delete(profile.id);
    });
    this.inFlightRefresh.set(profile.id, renewal);
    await renewal;
  }

  private async requestWithAuth<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions,
    retryOn401 = true,
    trace?: RequestTrace,
    authOptions?: { skipProactiveRefresh?: boolean }
  ): Promise<DataApiEnvelope<TResponse>> {
    if (trace) {
      trace.endpoint = redactString(`${request.method} ${request.path}`);
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
        ...(request.maxResponseBytes ? { maxContentLength: request.maxResponseBytes } : {}),
        // The Data API never redirects. Following one could send a login to another server or drop
        // the request body; a redirect is reported as an error that says where it pointed.
        maxRedirects: 0,
        httpsAgent: createHttpsAgentForProfile(profile)
      };

      const response = await this.httpClient.request<unknown>(config);
      return parseDataApiEnvelope<TResponse>(response);
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
        await this.renewRejectedSession(profile, token, { signal: request.signal });

        return this.requestWithAuth(profile, request, false, trace);
      }

      throw toFMClientError(
        normalizeError(error, {
          fallbackMessage: `FileMaker request failed (${redactString(`${request.method} ${request.path}`)}).`,
          requestId: trace?.requestId,
          endpoint: redactString(`${request.method} ${request.path}`)
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
      trace.endpoint = redactString(`${request.method} ${request.path}`);
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
        maxRedirects: 0,
        httpsAgent: createHttpsAgentForProfile(profile),
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304
      };

      const response = await this.httpClient.request<unknown>(config);
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
        envelope: parseDataApiEnvelope<TResponse>(response)
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
        await this.renewRejectedSession(profile, token, { signal: request.signal });

        return this.requestWithAuthRaw(profile, request, false, trace);
      }

      throw toFMClientError(
        normalizeError(error, {
          fallbackMessage: `FileMaker request failed (${redactString(`${request.method} ${request.path}`)}).`,
          requestId: trace?.requestId,
          endpoint: redactString(`${request.method} ${request.path}`)
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
      maxRedirects: 0,
      httpsAgent: createHttpsAgentForProfile(profile)
    };

    const response = await this.httpClient.request<unknown>(config);
    return parseDataApiEnvelope<TResponse>(response);
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
      if (context.operation === 'deleteSession') {
        this.setHealth(context.profileId, undefined);
      } else {
        this.setHealth(context.profileId, { state: 'connected', at: this.now() });
      }
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
      if (context.operation !== 'deleteSession') {
        this.setHealth(context.profileId, this.healthAfterFailure(error));
      }
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
  if (status === 405 || status === 501) {
    return true;
  }
  // A bare 404 is a wrong address or a disabled Data API, not "scripts unsupported": only a 404
  // that carries a FileMaker error code counts.
  return (
    status === 404 &&
    error instanceof FMClientError &&
    error.code !== undefined &&
    error.code !== NOT_DATA_API_CODE
  );
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
