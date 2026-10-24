import type { AxiosInstance } from 'axios';
import type { ConnectionProfile, FindRecordsRequest, FindRecordsResult } from '../../types/fm';
import type { DataApiEnvelope } from '../../types/dataApi';
import type { Logger } from '../logger';
import type { ProxyClient } from '../proxyClient';
import type { FMClientError } from '../errors';
import type { LayoutCacheEntry, RequestOptions, RequestTrace, ClientRequestControl, HistoryContext } from './types';

/** Internal access to the services owned by FMClient. Endpoint modules never import the client. */
export interface ClientContext {
  readonly httpClient: AxiosInstance;
  readonly proxyClient: ProxyClient;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  readonly timeoutMs: number;
  readonly layoutCache: Map<string, LayoutCacheEntry>;
  readonly layoutMetadataCache: Map<string, Record<string, unknown>>;
  readonly layoutMetadataEtags: Map<string, string>;
  withHistory<T>(
    context: HistoryContext,
    execute: (trace: RequestTrace) => Promise<T>
  ): Promise<T>;
  requestWithAuth<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions,
    retryOn401?: boolean,
    trace?: RequestTrace,
    authOptions?: { skipProactiveRefresh?: boolean }
  ): Promise<DataApiEnvelope<TResponse>>;
  requestWithAuthRaw<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions,
    retryOn401?: boolean,
    trace?: RequestTrace
  ): Promise<{
    status: number;
    headers: Record<string, string | undefined>;
    envelope?: DataApiEnvelope<TResponse>;
  }>;
  ensureSessionToken(
    profile: ConnectionProfile,
    control?: ClientRequestControl,
    options?: { skipProactiveRefresh?: boolean }
  ): Promise<string>;
  renewRejectedSession(
    profile: ConnectionProfile,
    rejectedToken: string,
    control?: ClientRequestControl
  ): Promise<void>;
  explainPinnedFailure(profile: ConnectionProfile, failure: FMClientError): FMClientError;
  refineCertificateError(profile: ConnectionProfile, failure: FMClientError): Promise<FMClientError>;
  getLayoutMetadata(
    profile: ConnectionProfile,
    layout: string,
    control?: ClientRequestControl & {
      /** Ancillary presentation lookups omit user history; metrics still record them. */
      recordHistory?: boolean;
    }
  ): Promise<Record<string, unknown>>;
  listRecords(
    profile: ConnectionProfile,
    layout: string,
    options?: { limit?: number; offset?: number; sort?: FindRecordsRequest['sort'] },
    control?: ClientRequestControl
  ): Promise<FindRecordsResult>;
}
