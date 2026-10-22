import { type AxiosError } from 'axios';
import { FMClientError } from '../errors';
import { normalizeError } from '../../utils/normalizeError';
import { redactString } from '../../utils/redact';
import { extractScriptErrors } from '../responseGuard';

/** `{ scriptErrors }` to spread into a result, or nothing when no script reported an error. */
export function scriptErrorsOf(response: unknown): { scriptErrors?: ReturnType<typeof extractScriptErrors> } {
  const scriptErrors = extractScriptErrors(response);
  return scriptErrors.length > 0 ? { scriptErrors } : {};
}

export function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof FMClientError) {
    return error.status;
  }

  const axiosError = error as AxiosError;
  if (axiosError?.isAxiosError) {
    return axiosError.response?.status;
  }

  return undefined;
}

export function getErrorMessage(error: unknown): string | undefined {
  const normalized = normalizeError(error);
  return redactString(normalized.message);
}

export function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
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
