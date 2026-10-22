import type { ConnectionProfile } from '../../types/fm';
import { FMClientError } from '../../services/errors';
import { redactString } from '../../utils/redact';
import { AiInputError } from '../aiSchema';
import { scrubGenericText } from '../aiText';
import { scrub } from '../aiScrub';

/** An error whose message is written for the model: it never carries a secret or the server address. */
export class AiToolError extends Error {
  public constructor(
    message: string,
    public readonly outcome: 'refused' | 'error' = 'refused'
  ) {
    super(message);
    this.name = 'AiToolError';
  }
}

export function errorNote(error: unknown): string | undefined {
  return error instanceof Error ? error.message.slice(0, 200) : undefined;
}

/** Turns anything thrown into a message safe to show the model: no server address, user name, IP, path or secret. */
export function toModelError(error: unknown, profile: ConnectionProfile | undefined): Error {
  if (error instanceof AiToolError) {
    return error;
  }
  if (error instanceof AiInputError) {
    return new AiToolError(`Invalid input: ${error.message}`);
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AiToolError('The request was cancelled.', 'error');
  }

  let text: string;
  if (error instanceof FMClientError) {
    const code = error.code ? ` (FileMaker error ${error.code})` : error.status ? ` (HTTP ${error.status})` : '';
    text = `The FileMaker request failed${code}: ${error.message}`;
  } else if (error instanceof Error) {
    text = `The request failed: ${error.message}`;
  } else {
    text = 'The request failed.';
  }
  return new AiToolError(scrubGenericText(scrub(redactString(text), profile)).slice(0, 500), 'error');
}
