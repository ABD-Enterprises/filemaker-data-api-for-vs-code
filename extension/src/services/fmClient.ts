import { createHash, randomUUID } from 'crypto';

import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';

import type {
  ConnectionProfile,
  PortalPaging,
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
import { assertNoNulText } from '../utils/nulText';
import { normalizeError } from '../utils/normalizeError';
import { buildProfileCacheKey, cacheKeyMatchesProfile } from '../utils/profileCacheKey';
import { isCredentialRejection } from '../utils/fileMakerCodes';
import { redactString } from '../utils/redact';
import { extractLayoutNames } from '../utils/layoutParser';
import { extractScriptNames } from '../utils/scriptParser';
import { SessionTokenTracker } from './session/sessionTokenTracker';
import { certificateTargetUrl, inspectServerCertificate } from './certificateInspect';
import { describeNetworkFailure, isFileMakerDefaultCertificate, targetOfUrl } from '../utils/networkErrors';
import { assertUsableUrlName } from '../utils/urlSegment';
import { environmentProxyFor, httpsTransportFor, noteRequestTimeout, pinBypassedByHost } from './tlsAgent';
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
  /** Percent-encode the query exactly (a space is `%20`, never `+`), as the Claris guide shows for script parameters. */
  strictQuery?: boolean;
  signal?: AbortSignal;
  /** Refuse a response body larger than this (axios maxContentLength). */
  maxResponseBytes?: number;
}

interface HistoryContext {
  recordHistory?: boolean;
  profileId: string;
  operation: string;
  layout?: string;
  endpoint: string;
}

interface RequestTrace {
  operation: string;
  requestId: string;
  reauthCount: number;
  cacheHit: boolean;
  endpoint: string;
}

interface ClientRequestControl {
  portal?: PortalPaging;
  signal?: AbortSignal;
  /**
   * The user asked for this sign-in (Connect, Test Connection). It goes ahead even when automatic
   * sign-ins are paused after the server rejected the stored credentials, and its result ends or
   * renews that pause.
   */
  userInitiated?: boolean;
  /**
   * A renewal ahead of expiry while the current token is still valid. If it fails, nothing is
   * paused and the caller keeps using the token it has.
   */
  proactive?: boolean;
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

/**
 * FileMaker reports "no records match the request" as error code 401. It is matched on that code,
 * whatever the HTTP status. Verified on a real FileMaker Data API Engine (2026-10-21):
 * HTTP 200, code 401, empty data. Older/other versions may use a different HTTP status.
 */
function isNoRecordsFound(error: unknown): boolean {
  return error instanceof FMClientError && error.code === '401';
}

/** Preserve the match count when an offset is beyond the last record. */
function emptyFindResult(error: unknown): FindRecordsResult {
  const details = error instanceof FMClientError ? error.details as { response?: { dataInfo?: FindRecordsResult['dataInfo'] }; dataInfo?: FindRecordsResult['dataInfo'] } | undefined : undefined;
  const dataInfo = details?.response?.dataInfo ?? details?.dataInfo;
  return { data: [], dataInfo: { ...dataInfo, foundCount: dataInfo?.foundCount ?? 0, returnedCount: 0 } };
}

const CERTIFICATE_LOOK_TTL_MS = 60_000;

export class FMClient {
  private readonly httpClient: AxiosInstance;
  private readonly proxyClient: ProxyClient;
  private readonly layoutCache = new Map<string, LayoutCacheEntry>();
  private readonly layoutMetadataCache = new Map<string, Record<string, unknown>>();
  private readonly layoutMetadataEtags = new Map<string, string>();
  private readonly sessionTracker: SessionTokenTracker;
  private readonly inFlightRefresh = new Map<string, Promise<string>>();
  private readonly health = new Map<string, SessionHealth>();
  /** The better certificate message (or none) per server and failure code, kept briefly so repeated failures do not each pay for a look. */
  private readonly certificateLooks = new Map<string, { at: number; message: Promise<string | undefined> }>();
  private readonly invalidationListeners = new Set<(profileId: string) => void>();
  private readonly healthListeners = new Set<(profileId: string, health: SessionHealth | undefined) => void>();
  /**
   * Profiles whose stored credentials FileMaker rejected (210, 211, 212, 213, 214). Automatic
   * sign-ins stop for them: trying again with the same password cannot work and repeated failures
   * can lock the account. The pause ends when the account, password or server changes, or when the
   * user runs Connect / Test Connection.
   */
  private readonly authPauses = new Map<string, AuthPause>();
  /**
   * Profiles whose last renewal ahead of expiry failed: no more of those are tried (each would be
   * another failed login) until a sign-in succeeds. The current token is used until the server
   * rejects it, and that rejection starts a real renewal, which can set a pause.
   */
  private readonly proactiveSuspended = new Set<string>();
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
    // A TLS agent that is replaced must outlive the longest request that may be running on it.
    noteRequestTimeout(this.timeoutMs);
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
          this.proactiveSuspended.delete(profile.id);

          return token;
        } catch (error) {
          const failure = toFMClientError(
            normalizeError(error, {
              fallbackMessage: 'Failed to create FileMaker session.',
              operation: trace.operation,
              requestId: trace.requestId,
              endpoint: 'POST /sessions'
            })
          );
          if (control?.proactive !== true) {
            this.recordSignInFailure(profile, stamp, failure);
          }
          throw await this.refineCertificateError(profile, failure);
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
        assertUsableUrlName(layout, 'layout');
        if (isProxyProfile(profile)) {
          if (control?.portal) throw new FMClientError('Loading more portal rows is unavailable through this proxy. Use a direct connection.');
          return this.proxyClient.getRecord(profile, layout, recordId, control?.signal);
        }

        const envelope = await this.requestWithAuth<DataApiListRecordsResponse>(
          profile,
          {
            method: 'GET',
            path: `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
            ...(control?.portal ? { params: portalPagingParams(control.portal, '_'), strictQuery: true } : {}),
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

        return withPortalInfo(record, envelope.response.dataInfo);
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
        assertUsableUrlName(layout, 'layout');
        if (isProxyProfile(profile)) {
          try {
            return await this.proxyClient.findRecords(profile, layout, body, control?.signal);
          } catch (error) {
            // The proxy passes FileMaker's code on, so "no records match" is an empty result here too.
            if (isNoRecordsFound(error)) {
              return emptyFindResult(error);
            }
            throw error;
          }
        }

        const payload: Record<string, unknown> = {
          query: body.query,
          ...portalPagingParams(body.portal, '')
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

        for (const key of ['script', 'script.param', 'script.prerequest', 'script.prerequest.param', 'script.presort', 'script.presort.param'] as const) {
          if (body[key] !== undefined) payload[key] = body[key];
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
          // FileMaker answers a find with no matches (or an offset past the last match) with code 401.
          // A real server returns HTTP 200 with empty data; older/other versions may use another status:
          // match the code alone. That is a result, not a failure.
          if (isNoRecordsFound(error)) {
            return emptyFindResult(error);
          }
          throw error;
        }

        return {
          data: (envelope.response.data ?? []).map((record) => withPortalInfo(record, envelope.response.dataInfo)),
          dataInfo: envelope.response.dataInfo,
          ...scriptErrorsOf(envelope.response)
        };
      }
    );
  }

  public async getLayoutMetadata(
    profile: ConnectionProfile,
    layout: string,
    control?: ClientRequestControl & {
      /** Ancillary presentation lookups omit user history; metrics still record them. */
      recordHistory?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'getLayoutMetadata',
        recordHistory: control?.recordHistory,
        layout,
        endpoint: `GET /layouts/${layout}`
      },
      async (trace) => {
        assertUsableUrlName(layout, 'layout');
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
        assertUsableUrlName(layout, 'layout');
        assertNoNulText(fieldDataPartial);
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
        assertUsableUrlName(layout, 'layout');
        assertNoNulText(fieldData);
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
        assertUsableUrlName(layout, 'layout');
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
    // Layout and field names are used exactly as given: a leading or trailing space is part of the name, and
    // trimming it would send the upload to a different layout or field (`Sales` instead of ` Sales`).
    const normalizedLayout = layout;
    const normalizedRecordId = recordId.trim();
    const normalizedFieldName = fieldName;
    assertUsableUrlName(normalizedLayout, 'layout');
    assertUsableUrlName(normalizedFieldName, 'field');
    const normalizedFileName = file.fileName.trim();
    const content = normalizeUploadContent(file.content);

    if (!normalizedLayout.trim()) {
      throw new FMClientError('Layout is required to upload container data.');
    }
    if (!normalizedRecordId) {
      throw new FMClientError('Record ID is required to upload container data.');
    }
    if (!normalizedFieldName.trim()) {
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

  /**
   * Runs a FileMaker script the way the Claris Data API Guide documents it ("Run a script",
   * https://help.claris.com/en/data-api-guide/content/run-a-script.html):
   *
   *   GET /fmi/data/<version>/databases/<db>/layouts/<layout>/script/<script>?script.param=<text>
   *
   * The response carries `scriptError` (and `scriptResult` when the script exits with a result).
   * Nothing else is requested: no record is read or changed.
   *
   * Two documented alternatives exist, used only where the plain call cannot be:
   *  - a script that must run with a record in context, or that cannot run on the script endpoint
   *    (an older server answers 405, 501 or a FileMaker 404), is attached to another request
   *    ("Run a script with another request", .../run-script-with-another-request.html): a GET of
   *    that one record, or, with no record, a find limited to one record;
   *  - a parameter too long for a URL (the guide advises keeping a URL under 2000 characters,
   *    .../url-data-format-notes.html) goes in the body of that find, because the script endpoint
   *    takes `script.param` only in the URL.
   * The find is the least harmful documented carrier: it changes nothing, and `limit: 1` keeps the
   * data it returns to one record. It still reads that record, which is why it is not the first choice.
   */
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
        endpoint: `GET /layouts/${request.layout}/script/${request.scriptName}`
      },
      async (trace) => {
        assertUsableUrlName(request.scriptName, 'script');
        assertUsableUrlName(request.layout, 'layout');
        if (isProxyProfile(profile)) {
          return this.proxyClient.runScript(profile, request, control?.signal);
        }

        // Names are used exactly as given (see uploadContainer): only an empty or all-blank name is refused.
        const scriptName = request.scriptName;
        if (!scriptName.trim()) {
          throw new FMClientError('Script name is required.');
        }

        const layout = request.layout;
        if (!layout.trim()) {
          throw new FMClientError('Layout is required to run script.');
        }

        const scriptParam = request.scriptParam !== undefined && request.scriptParam.length > 0 ? request.scriptParam : undefined;
        const ifTooLong = (path: string, query: Record<string, string>): boolean =>
          this.buildEndpoint(profile, path).length + 1 + strictQuerySerializer(query).length > MAX_SCRIPT_URL_LENGTH;

        const attach = async (): Promise<RunScriptResult> => {
          if (request.recordId) {
            // GET: the script parameters are query parameters.
            const recordPath = `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(request.recordId)}`;
            const query = buildScriptParams(scriptName, scriptParam);
            if (ifTooLong(recordPath, query as Record<string, string>)) {
              throw tooLongScriptParameter();
            }
            const envelope = await this.requestWithAuth<Record<string, unknown>>(
              profile,
              { method: 'GET', path: recordPath, params: query, strictQuery: true, signal: control?.signal },
              true,
              trace
            );
            return { response: withoutRecordData(envelope.response), messages: envelope.messages };
          }
          // POST: the script parameters are in the body, so a long one fits.
          const envelope = await this.requestWithAuth<Record<string, unknown>>(
            profile,
            {
              method: 'POST',
              path: `/layouts/${encodeURIComponent(layout)}/_find`,
              data: { query: [{}], limit: 1, ...buildScriptParams(scriptName, scriptParam) },
              signal: control?.signal
            },
            true,
            trace
          );
          return { response: withoutRecordData(envelope.response), messages: envelope.messages };
        };

        const failure = (error: unknown, endpoint: string): FMClientError =>
          this.explainPinnedFailure(
            profile,
            toFMClientError(
              normalizeError(error, {
                fallbackMessage: 'Failed to run FileMaker script.',
                operation: trace.operation,
                requestId: trace.requestId,
                endpoint
              })
            )
          );

        // A record in context cannot be given to the script endpoint.
        if (request.recordId) {
          try {
            return await attach();
          } catch (error) {
            if (error instanceof FMClientError && error.code === 'SCRIPT_PARAMETER_TOO_LONG') {
              throw error;
            }
            if (isLikelyScriptUnsupportedError(error)) {
              throw scriptUnsupported(error);
            }
            throw failure(error, `GET /layouts/${request.layout}/records/${request.recordId}`);
          }
        }

        const scriptPath = `/layouts/${encodeURIComponent(layout)}/script/${encodeURIComponent(scriptName)}`;
        const query: Record<string, string> = scriptParam === undefined ? {} : { 'script.param': scriptParam };

        // Too long for a URL: use the documented body form from the start (no failed request first).
        if (ifTooLong(scriptPath, query)) {
          try {
            return await attach();
          } catch (error) {
            if (isLikelyScriptUnsupportedError(error)) {
              throw scriptUnsupported(error);
            }
            throw failure(error, `POST /layouts/${request.layout}/_find`);
          }
        }

        try {
          const envelope = await this.requestWithAuth<Record<string, unknown>>(
            profile,
            { method: 'GET', path: scriptPath, params: query, strictQuery: true, signal: control?.signal },
            true,
            trace
          );
          return { response: withoutRecordData(envelope.response), messages: envelope.messages };
        } catch (error) {
          if (!isLikelyScriptUnsupportedError(error)) {
            throw failure(error, `GET /layouts/${request.layout}/script/${request.scriptName}`);
          }
        }

        // The script endpoint was refused for a reason that is about the endpoint itself: use the documented
        // "another request" form instead.
        try {
          return await attach();
        } catch (error) {
          if (isLikelyScriptUnsupportedError(error)) {
            throw scriptUnsupported(error);
          }
          throw failure(error, `POST /layouts/${request.layout}/_find`);
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

  /** Unauthenticated connection diagnosis through the same transport as Test Connection. */
  public async getProductInfoDiagnostics(
    profile: ConnectionProfile,
    control?: ClientRequestControl
  ): Promise<{ status: number; code?: string; name?: string; version?: string }> {
    let status = 0;
    const envelope = await this.requestServerLevel<{ productInfo?: Record<string, unknown> }>(
      profile, '/productInfo', control, 'Failed to reach the FileMaker Data API.',
      (value) => { status = value; }, true
    );
    const info = envelope.response.productInfo ?? {};
    return {
      status,
      code: envelope.messages[0]?.code,
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
    fallbackMessage: string,
    onStatus?: (status: number) => void,
    skipCertificateInspection = false
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
        ...httpsTransportFor(profile, `${base}${basePath}/${version}${path}`)
      });
      onStatus?.(response.status);
      return parseDataApiEnvelope<TResponse>(response);
    } catch (error) {
      const failure = toFMClientError(normalizeError(error, { fallbackMessage, endpoint: `GET ${path}` }));
      // Diagnosis already read the peer certificate with its own cancellable deadline.
      throw (skipCertificateInspection
        ? this.explainPinnedFailure(profile, failure)
        : await this.refineCertificateError(profile, failure));
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

  /** A pinned profile's certificate failure, explained when the host replaced the agent that would have applied the pin. */
  private explainPinnedFailure(profile: ConnectionProfile, failure: FMClientError): FMClientError {
    return pinBypassedByHost(profile, failure) ?? failure;
  }

  /**
   * When the certificate was refused because this computer does not trust its issuer, look at what
   * the server presents (one extra handshake, no request, at most 1.5 s, made directly and not through any proxy) and, if it is FileMaker Server's own
   * default certificate, say so in the message. Best effort: any problem returns the error as it was.
   */
  private async refineCertificateError(profile: ConnectionProfile, failure: FMClientError): Promise<FMClientError> {
    const untrusted = new Set([
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN'
    ]);
    const bypassed = pinBypassedByHost(profile, failure);
    if (bypassed) {
      return bypassed;
    }
    if (failure.kind !== 'certificate' || !failure.networkCode || !untrusted.has(failure.networkCode)) {
      return failure;
    }
    const url = certificateTargetUrl(profile);
    // This look dials the server directly; behind a proxy it would only hang, so it is skipped there.
    if (!url || environmentProxyFor(url)) {
      return failure;
    }
    // One look per server and failure for a minute: every failed request would otherwise pay the
    // handshake again (up to 1.5 s), and a server that does not answer would cost the full wait each time.
    const key = `${url}|${failure.networkCode}`;
    const now = this.now();
    let look = this.certificateLooks.get(key);
    if (!look || now - look.at > CERTIFICATE_LOOK_TTL_MS || now < look.at) {
      if (this.certificateLooks.size >= 32) {
        this.certificateLooks.delete(this.certificateLooks.keys().next().value as string);
      }
      look = { at: now, message: this.lookAtCertificate(url, failure.networkCode) };
      this.certificateLooks.set(key, look);
    }
    const message = await look.message;
    return message
      ? new FMClientError(message, {
          status: failure.status,
          code: failure.code,
          networkCode: failure.networkCode,
          kind: failure.kind,
          isRetryable: failure.isRetryable,
          details: failure.details,
          requestId: failure.requestId,
          endpoint: failure.endpoint
        })
      : failure;
  }

  /** The message that names what the server presented, or undefined when the look fails or adds nothing. */
  private async lookAtCertificate(url: string, networkCode: string): Promise<string | undefined> {
    try {
      const info = await inspectServerCertificate(url, 1500);
      const better = describeNetworkFailure(networkCode, {
        ...targetOfUrl(url),
        fileMakerDefaultCertificate: isFileMakerDefaultCertificate(info),
        certificateListsHostNames: info.altNames.length > 0
      });
      return better?.message;
    } catch {
      return undefined;
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

  /**
   * What a failed request says about the connection, or undefined when it says nothing and the last
   * known state should stand. Only a FileMaker answer (an error code) proves the connection works;
   * a gateway error or a cancelled request proves nothing.
   */
  private healthAfterFailure(error: unknown): SessionHealth | undefined {
    const at = this.now();
    if (!(error instanceof FMClientError)) {
      return undefined;
    }
    if (error.kind === 'cancellation') {
      return undefined;
    }
    if (error.kind === 'certificate') {
      return { state: 'certificate', message: error.message, at };
    }
    if (error.fmCategory === 'credentials' || (error.kind === 'auth' && error.fmCategory !== 'privilege')) {
      return { state: 'auth-failed', message: error.message, at };
    }
    if (error.networkCode || error.kind === 'network' || error.kind === 'timeout') {
      return { state: 'unreachable', message: error.message, at };
    }
    if (error.code === 'NOT_DATA_API_RESPONSE') {
      return { state: 'unreachable', message: error.message, at };
    }
    if (error.code === undefined) {
      // No FileMaker answer: a gateway or proxy error (502, 503, 504 ...) or a bare 404 means the
      // Data API did not answer. Other statuses without a code say nothing certain.
      if (typeof error.status === 'number' && (error.status >= 500 || error.status === 404)) {
        return { state: 'unreachable', message: error.message, at };
      }
      return undefined;
    }
    // An answer from FileMaker (a missing layout, a refused write) proves the connection works.
    return { state: 'connected', at };
  }

  /** Ends a pause on automatic sign-ins now (the credentials were just edited). */
  public clearAuthPause(profileId: string): void {
    this.authPauses.delete(profileId);
    this.sessionLimitBackoff.delete(profileId);
    this.proactiveSuspended.delete(profileId);
  }

  /**
   * Forgets everything held for a profile id that is no longer used (the throwaway profile behind a
   * Test Connection): pause, backoff, health and token timing.
   */
  public forgetProfile(profileId: string): void {
    this.authPauses.delete(profileId);
    this.sessionLimitBackoff.delete(profileId);
    this.proactiveSuspended.delete(profileId);
    this.sessionTracker.clear(profileId);
    this.inFlightRefresh.delete(profileId);
    this.setHealth(profileId, undefined);
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
          `Sign-in is paused: FileMaker rejected the saved credentials (error ${pause.code}) and the extension will not try again on its own, so repeated attempts cannot lock the account.${pause.code === '214' ? ' Error 214 can be a temporary lockout: wait a while before trying again.' : ''} Edit the connection to fix the account or password, or run "FileMaker: Connect".`,
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
        `FileMaker has reached its maximum number of database or Admin API sessions. Waiting ${seconds} s before signing in again (run "FileMaker: Connect" to try now), or ask the administrator to disconnect idle clients.`,
        { code: '956', kind: 'server', fmCategory: 'transient', isRetryable: true, retryAfterMs: wait.until - this.now() }
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

    if (existing && (skipProactive || this.proactiveSuspended.has(profile.id) || !this.shouldRefreshSession(profile.id))) {
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

    // A renewal ahead of expiry that fails (the password changed meanwhile, the server is busy) must
    // not stop work that the current token can still do: keep using it, and pause nothing. If the
    // token has really expired, the 401 on the next request starts a real renewal, which can pause.
    const refreshPromise = this.createSession(profile, existing ? { ...control, proactive: true } : control)
      .catch((error) => {
        if (!existing) {
          throw error;
        }
        this.proactiveSuspended.add(profile.id);
        this.logger.warn('Proactive session renewal failed; continuing with the current token.', {
          profileId: profile.id,
          error
        });
        return existing;
      })
      .finally(() => {
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
        ...(request.strictQuery ? { paramsSerializer: { serialize: strictQuerySerializer } } : {}),
        signal: request.signal,
        timeout: this.timeoutMs,
        maxBodyLength: Infinity,
        ...(request.maxResponseBytes ? { maxContentLength: request.maxResponseBytes } : {}),
        // The Data API never redirects. Following one could send a login to another server or drop
        // the request body; a redirect is reported as an error that says where it pointed.
        maxRedirects: 0,
        ...httpsTransportFor(profile, this.buildEndpoint(profile, request.path))
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

      throw this.explainPinnedFailure(
        profile,
        toFMClientError(
          normalizeError(error, {
            operation: trace?.operation,
            requestData: request.data,
            requestParams: request.params,
            fallbackMessage: `FileMaker request failed (${redactString(`${request.method} ${request.path}`)}).`,
            requestId: trace?.requestId,
            endpoint: redactString(`${request.method} ${request.path}`)
          })
        )
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
        ...(request.strictQuery ? { paramsSerializer: { serialize: strictQuerySerializer } } : {}),
        signal: request.signal,
        timeout: this.timeoutMs,
        maxBodyLength: Infinity,
        maxRedirects: 0,
        ...httpsTransportFor(profile, this.buildEndpoint(profile, request.path)),
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

      throw this.explainPinnedFailure(
        profile,
        toFMClientError(
          normalizeError(error, {
            operation: trace?.operation,
            requestData: request.data,
            requestParams: request.params,
            fallbackMessage: `FileMaker request failed (${redactString(`${request.method} ${request.path}`)}).`,
            requestId: trace?.requestId,
            endpoint: redactString(`${request.method} ${request.path}`)
          })
        )
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
      ...httpsTransportFor(profile, this.buildEndpoint(profile, request.path))
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
      operation: context.operation,
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
      if (context.recordHistory !== false) await this.recordHistory({
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
        const health = this.healthAfterFailure(error);
        if (health) {
          this.setHealth(context.profileId, health);
        }
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
      if (context.recordHistory !== false) await this.recordHistory({
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

/** The Claris guide advises keeping a Data API URL under 2000 characters (URL and data format notes). */
export const MAX_SCRIPT_URL_LENGTH = 2000;

/** `a=b&c=d` with every key and value percent-encoded (a space is `%20`, a `+` is `%2B`, a `|` is `%7C`). */
function strictQuerySerializer(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/**
 * A script run is not a data request. When the script is attached to a record or a find, that request's own
 * record(s) (`data`, `dataInfo`) come back too; they are not part of the script's answer and are dropped, so no
 * consumer (Layout Mode, the preview bridge, the AI tools, Script Runner) passes a record along by accident.
 */
function withoutRecordData(response: Record<string, unknown>): Record<string, unknown> {
  const { data: _data, dataInfo: _dataInfo, ...rest } = response;
  void _data;
  void _dataInfo;
  return rest;
}

function tooLongScriptParameter(): FMClientError {
  return new FMClientError(
    `The script parameter is too long to send in a web address (the limit is about ${MAX_SCRIPT_URL_LENGTH} characters including the server and script name). Shorten it, for example by passing an id or a key and letting the script read the rest.`,
    { code: 'SCRIPT_PARAMETER_TOO_LONG', kind: 'validation', isRetryable: false }
  );
}

function scriptUnsupported(error: unknown): FMClientError {
  return new FMClientError('Script runner is not supported on this server/profile.', {
    code: 'SCRIPT_UNSUPPORTED',
    status: getErrorStatus(error),
    details: error
  });
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

function portalPagingParams(portals: PortalPaging | undefined, prefix: string): Record<string, number> {
  const params: Record<string, number> = {};
  for (const [name, page] of Object.entries(portals ?? {})) {
    params[`${prefix}limit.${name}`] = page.limit;
    if (page.offset !== undefined) params[`${prefix}offset.${name}`] = page.offset;
  }
  return params;
}

function withPortalInfo(record: FileMakerRecord, dataInfo?: Record<string, unknown>): FileMakerRecord {
  const info = record.portalDataInfo ?? dataInfo?.portalDataInfo;
  return Array.isArray(info) ? { ...record, portalDataInfo: info } : record;
}
