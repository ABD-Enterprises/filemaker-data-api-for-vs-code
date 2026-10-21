import { ensureAgentReplacedPolicy, hostNetworkingPatched } from './tlsAgent';

/** Whether VS Code's actual networking patch is active (error fallback only). */
export function proxySupportReplacesAgent(): boolean {
  return hostNetworkingPatched();
}

/**
 * Installs the fallback-error policy. Called wherever the answer is needed first: when the connection client
 * loads and when the "trust this certificate" dialog opens, which can happen before any request (the wizard's
 * "Review server certificate", the start-up notice for older profiles). Safe to call again.
 */
export function installAgentReplacedPolicy(): void {
  ensureAgentReplacedPolicy(proxySupportReplacesAgent);
}
