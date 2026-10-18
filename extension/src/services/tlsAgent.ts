import { readFileSync, statSync } from 'fs';
import { Agent, type AgentOptions } from 'https';
import { rootCertificates } from 'tls';

import type { ConnectionProfile } from '../types/fm';
import { FMClientError } from './errors';

type TlsProfileOptions = Pick<ConnectionProfile, 'allowSelfSigned' | 'caBundlePath'>;

const agentCache = new Map<string, Agent>();

export function createHttpsAgentForProfile(profile: TlsProfileOptions): Agent {
  const allowSelfSigned = profile.allowSelfSigned === true;
  const caBundlePath = profile.caBundlePath?.trim();

  // Keyed by the file's size and modification time as well as its path, so a renewed or edited
  // CA file is picked up without restarting VS Code.
  let fileStamp = 'none';
  if (caBundlePath) {
    try {
      const info = statSync(caBundlePath);
      fileStamp = `${info.size}:${info.mtimeMs}`;
    } catch (error) {
      throw buildCaBundleError(caBundlePath, error);
    }
  }
  const cacheKey = `${allowSelfSigned ? 'self-signed' : 'verified'}:${caBundlePath ?? 'none'}:${fileStamp}`;
  const cachedAgent = agentCache.get(cacheKey);
  if (cachedAgent) {
    return cachedAgent;
  }

  const options: AgentOptions = {
    rejectUnauthorized: !allowSelfSigned
  };

  if (caBundlePath) {
    try {
      // Node's `ca` option replaces the built-in public roots, which would make every server with
      // a public certificate fail once a custom CA is set. Keep the defaults and add the file's
      // certificates, so the file extends the trust list.
      options.ca = [...rootCertificates, readFileSync(caBundlePath, 'utf8')];
    } catch (error) {
      throw buildCaBundleError(caBundlePath, error);
    }
  }

  // Drop agents made for an earlier version of the same file.
  const prefix = `${allowSelfSigned ? 'self-signed' : 'verified'}:${caBundlePath ?? 'none'}:`;
  for (const key of agentCache.keys()) {
    if (key.startsWith(prefix)) {
      agentCache.delete(key);
    }
  }

  const agent = new Agent(options);
  agentCache.set(cacheKey, agent);
  return agent;
}

function buildCaBundleError(caBundlePath: string, error: unknown): FMClientError {
  return new FMClientError(`Unable to read TLS CA bundle at ${caBundlePath}.`, {
    code: 'TLS_CA_BUNDLE_READ_FAILED',
    details: {
      caBundlePath,
      error
    }
  });
}
