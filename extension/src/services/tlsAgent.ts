import { readFileSync } from 'fs';
import { Agent, type AgentOptions } from 'https';

import type { ConnectionProfile } from '../types/fm';
import { FMClientError } from './errors';

type TlsProfileOptions = Pick<ConnectionProfile, 'allowSelfSigned' | 'caBundlePath'>;

const agentCache = new Map<string, Agent>();

export function createHttpsAgentForProfile(profile: TlsProfileOptions): Agent {
  const allowSelfSigned = profile.allowSelfSigned === true;
  const caBundlePath = profile.caBundlePath?.trim();
  const cacheKey = `${allowSelfSigned ? 'self-signed' : 'verified'}:${caBundlePath ?? 'none'}`;
  const cachedAgent = agentCache.get(cacheKey);
  if (cachedAgent) {
    return cachedAgent;
  }

  const options: AgentOptions = {
    rejectUnauthorized: !allowSelfSigned
  };

  if (caBundlePath) {
    try {
      options.ca = readFileSync(caBundlePath, 'utf8');
    } catch (error) {
      throw buildCaBundleError(caBundlePath, error);
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
