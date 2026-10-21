import http from 'http';
import https from 'https';

import { createHttpPatch, createProxyResolver, LogLevel, type ProxyAgentParams, type ProxySupportSetting } from '@vscode/proxy-agent';

/** Same module snapshots and Object.assign used by the installed VS Code extension host. */
export function installVscodeProxyPatch(mode: ProxySupportSetting, options: {
  proxy?: string;
  resolveProxy?: (url: string) => Promise<string | undefined>;
} = {}): () => void {
  const params: ProxyAgentParams = {
    getProxySupport: () => mode,
    getProxyURL: () => options.proxy,
    resolveProxy: options.resolveProxy ?? (async () => 'DIRECT'),
    getNoProxyConfig: () => [],
    isAdditionalFetchSupportEnabled: () => false,
    isWebSocketPatchEnabled: () => false,
    addCertificatesV1: () => false,
    addCertificatesV2: () => false,
    loadSystemCertificatesFromNode: () => false,
    loadAdditionalCertificates: async () => [],
    isUseHostProxyEnabled: () => true,
    env: {},
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    getLogLevel: () => LogLevel.Off,
    proxyResolveTelemetry() {}
  };
  const { resolveProxyWithRequest } = createProxyResolver(params);
  const modules = [http, https];
  const saved = modules.map((mod) => ({ ...mod }));
  modules.forEach((mod, i) => {
    Object.assign(mod, { __vscodeOriginal: saved[i] }, createHttpPatch(params, saved[i]!, resolveProxyWithRequest));
  });
  return () => modules.forEach((mod, i) => {
    Object.assign(mod, { request: saved[i]!.request, get: saved[i]!.get });
    delete (mod as typeof http & { __vscodeOriginal?: unknown }).__vscodeOriginal;
  });
}
