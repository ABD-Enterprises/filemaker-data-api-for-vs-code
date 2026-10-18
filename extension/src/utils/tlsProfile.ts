import { stat, readFile } from 'fs/promises';
import path from 'path';

import type { ConnectionProfile } from '../types/fm';

const MAX_CA_BUNDLE_BYTES = 1024 * 1024;

export interface CaBundleValidation {
  ok: boolean;
  /** The trimmed absolute path, when ok. */
  value?: string;
  error?: string;
}

/**
 * Checks a "custom CA certificate file" before it is saved on a profile: an absolute path
 * to a readable PEM file that holds at least one certificate and no private key. (A relative
 * path would depend on the extension host's working directory, and a private key has no
 * business in a trust list.)
 */
export async function validateCaBundleFile(rawPath: string): Promise<CaBundleValidation> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: 'Enter the path to a CA certificate file.' };
  }
  if (trimmed.includes('\0') || !path.isAbsolute(trimmed)) {
    return { ok: false, error: 'The CA certificate file must be given as an absolute path.' };
  }

  try {
    const info = await stat(trimmed);
    if (!info.isFile()) {
      return { ok: false, error: 'The CA certificate path is not a file.' };
    }
    if (info.size > MAX_CA_BUNDLE_BYTES) {
      return { ok: false, error: 'The CA certificate file is larger than 1 MB, so it is probably not a certificate.' };
    }
    const content = await readFile(trimmed, 'utf8');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
      return { ok: false, error: 'That file contains a private key. Choose the CA certificate (public) file instead.' };
    }
    if (!/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(content)) {
      return { ok: false, error: 'The file is not a PEM certificate (no BEGIN CERTIFICATE block found).' };
    }
  } catch {
    return { ok: false, error: 'The CA certificate file could not be read. Check the path and permissions.' };
  }

  return { ok: true, value: trimmed };
}

/** Short text for profile lists and tooltips when the profile changes how TLS is checked. */
export function describeTlsSettings(
  profile: Pick<ConnectionProfile, 'allowSelfSigned' | 'caBundlePath'>
): string | undefined {
  const parts: string[] = [];
  if (profile.allowSelfSigned === true) {
    parts.push('⚠ accepts any certificate (insecure)');
  }
  if (profile.caBundlePath?.trim()) {
    parts.push('custom CA');
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}
