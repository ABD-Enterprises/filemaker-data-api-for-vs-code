import type { AxiosError } from 'axios';
import * as vscode from 'vscode';

import { environmentProxyFor, hostReplacesAgentFor } from '../services/tlsAgent';
import type { NetworkFailure } from './networkErrors';

/** Identify a failed proxy connection only when the selected route or failing address confirms it. */
export function proxyConnectionFailure(error: AxiosError, failure: NetworkFailure): string | undefined {
  if (!['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(failure.code)) return undefined;
  const request = error.request as { agent?: { proxy?: unknown }; _currentRequest?: { agent?: { proxy?: unknown } } } | undefined;
  const selected = request?.agent?.proxy ?? request?._currentRequest?.agent?.proxy;
  const configured = error.config?.proxy;
  const explicit = configured && typeof configured === 'object' ? configured : undefined;
  const environment = error.config?.url && configured !== false && !explicit ? environmentProxyFor(error.config.url) : undefined;
  const http = vscode.workspace.getConfiguration('http');
  const hostProxy = error.config?.url && !error.config.transport && hostReplacesAgentFor(error.config.url) && http.get<string>('proxySupport', 'override') !== 'off'
    ? http.get<string>('proxy', '') : undefined;
  let proxy: URL;
  try {
    if (selected) proxy = new URL(String(selected));
    else if (explicit) proxy = new URL(`${explicit.protocol ?? 'http'}://${explicit.host}:${explicit.port}`);
    else if (environment) proxy = new URL(environment);
    else if (hostProxy) proxy = new URL(hostProxy);
    else return undefined;
  } catch { return undefined; }
  const host = proxy.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = proxy.port || (proxy.protocol === 'https:' ? '443' : '80');
  const visited = new Set<unknown>();
  const matches = (value: unknown, depth = 0): boolean => {
    if (!value || typeof value !== 'object' || visited.has(value) || depth > 6) return false;
    visited.add(value);
    const entry = value as { hostname?: string; address?: string; port?: number; cause?: unknown; errors?: unknown[] };
    const failedHost = entry.hostname ?? entry.address;
    const portMatches = entry.port === undefined || String(entry.port) === port;
    if (portMatches && (failedHost?.toLowerCase() === host || (selected && entry.port !== undefined))) return true;
    return matches(entry.cause, depth + 1) || (Array.isArray(entry.errors) && entry.errors.some((inner) => matches(inner, depth + 1)));
  };
  if (!matches(error)) return undefined;
  // Never echo the URL: it may contain proxy credentials.
  return `The proxy ${proxy.hostname}:${port} could not be reached (${failure.code}). Check ${environment ? 'HTTPS_PROXY / HTTP_PROXY / ALL_PROXY and NO_PROXY' : 'VS Code http.proxy or the system proxy'}, and VS Code http.proxySupport. Ask your network administrator to check the proxy address and port.`;
}
