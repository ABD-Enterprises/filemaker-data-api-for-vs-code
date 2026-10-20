import { SnippetError } from './model';

/** `https://host[/prefix]` without user name, password, query or fragment, or a clear error. */
export function cleanServerAddress(address: string, what: string, preserveTrailingSlash = false): string {
  let parsed: URL;
  try {
    parsed = new URL(address.trim());
  } catch {
    // The text is not echoed: an address typed wrongly may still hold an account or a token.
    throw new SnippetError(`The ${what} of the connection profile is not a valid web address.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SnippetError(`The ${what} must start with https:// or http://.`);
  }
  return `${parsed.protocol}//${parsed.host}${preserveTrailingSlash ? parsed.pathname : parsed.pathname.replace(/\/+$/, '')}`;
}

