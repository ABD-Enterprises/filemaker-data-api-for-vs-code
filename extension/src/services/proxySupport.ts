import * as vscode from 'vscode';

import { ensureAgentReplacedPolicy } from './tlsAgent';

/**
 * Whether VS Code's `http.proxySupport` setting is "override" (its default). VS Code then replaces the extension's
 * own connection, so a trusted (pinned) certificate cannot be checked (see `pinBypassedByHost` in tlsAgent.ts).
 */
export function proxySupportReplacesAgent(): boolean {
  return vscode.workspace.getConfiguration('http').get<string>('proxySupport', 'override') === 'override';
}

/**
 * Tells the TLS code about that setting. Called wherever the answer is needed first: when the connection client
 * loads and when the "trust this certificate" dialog opens, which can happen before any request (the wizard's
 * "Review server certificate", the start-up notice for older profiles). Safe to call again.
 */
export function installAgentReplacedPolicy(): void {
  ensureAgentReplacedPolicy(proxySupportReplacesAgent);
}
