import { domainToUnicode } from 'url';

import type { ConnectionProfile } from '../types/fm';
import { SERVER_MARKER } from './aiText';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An IPv6 address as eight lower-case four-digit groups, however it was written; undefined if it is not one. */
function canonicalIPv6(address: string): string | undefined {
  let lower = address.toLowerCase();
  // An embedded IPv4 tail (`::ffff:10.1.2.3`) is two more groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (dotted) {
    const octets = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number);
    if (octets.some((octet) => octet > 255)) {
      return undefined;
    }
    lower = `${dotted[1]}${((octets[0] as number) * 256 + (octets[1] as number)).toString(16)}:${((octets[2] as number) * 256 + (octets[3] as number)).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(lower) || (lower.match(/::/g) ?? []).length > 1 || lower.includes(':::')) {
    return undefined;
  }
  const [head = '', tail = ''] = lower.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const compressed = lower.includes('::');
  const missing = 8 - left.length - right.length;
  if (compressed ? missing < 1 : left.length !== 8) {
    return undefined;
  }
  const groups = compressed ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
  return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map((group) => group.padStart(4, '0')).join(':') : undefined;
}

/**
 * Removes the server address of a profile from text, however it is written: the URL and
 * origin and `host:port` (any letter case), the host name as a whole token (so `fm` does not
 * match inside "confirm"), a host name in its Unicode and punycode forms, and an IP address
 * (IPv6 compressed, expanded or unpadded, with or without brackets). The user name is NOT
 * removed as a plain word ("contact the admin" stays); a name inside a URL or after `@` is
 * covered by the host and by redaction of credentials in URLs.
 */
export function scrub(text: string, profile: ConnectionProfile | undefined): string {
  if (!profile) {
    return text;
  }
  const literals = new Set<string>();
  /** `host` or `[v6]` forms: the port after them, if any, goes too. */
  const hostLiterals = new Set<string>();
  const hosts = new Set<string>();
  const addresses = new Set<string>();
  const addUrl = (value: string | undefined): void => {
    if (!value) return;
    literals.add(value);
    try {
      const url = new URL(value);
      literals.add(url.origin);
      literals.add(url.host);
      hostLiterals.add(url.host);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (url.hostname.startsWith('[')) {
        const canonical = canonicalIPv6(hostname);
        if (canonical) addresses.add(canonical);
      } else {
        hosts.add(hostname);
        // An IPv4 server also appears as an IPv4-mapped IPv6 address (`::ffff:10.1.2.3`).
        const mapped = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ? canonicalIPv6(`::ffff:${hostname}`) : undefined;
        if (mapped) addresses.add(mapped);
        const unicode = domainToUnicode(hostname);
        if (unicode) hosts.add(unicode);
      }
    } catch {
      // Not a URL: only the literal text is scrubbed.
    }
  };
  addUrl(profile.serverUrl);
  addUrl(profile.proxyEndpoint);

  let result = text;
  for (const literal of [...literals].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    const port = hostLiterals.has(literal) && !/:\d+$/.test(literal) ? '(?::\\d{1,5})?' : '';
    result = result.replace(new RegExp(`${escapeRegExp(literal)}${port}`, 'gi'), SERVER_MARKER);
  }
  if (addresses.size > 0) {
    // Any spelling of the address: bracketed (with a port) or bare, compressed, padded or not,
    // with an IPv4 tail, and bare with a port (`2001:db8::10:443` is the address `2001:db8::10`
    // and port 443, as well as a valid address of its own: both are the server's, so both go).
    const isServer = (candidate: string): boolean => {
      const canonical = canonicalIPv6(candidate);
      return canonical !== undefined && addresses.has(canonical);
    };
    const matches = (token: string): boolean => {
      if (isServer(token)) return true;
      const port = /^(.*[0-9a-f:]):(\d{1,5})$/i.exec(token);
      return port !== null && !token.endsWith('::') && isServer(port[1] as string);
    };
    result = result
      .replace(/\[([0-9a-f:.]{3,})\](?::\d{1,5})?/gi, (match, inner: string) => (isServer(inner) ? SERVER_MARKER : match))
      .replace(/(?<![0-9a-f:.])[0-9a-f:.]{3,}(?![0-9a-f:])/gi, (match) => {
        const trailing = /\.+$/.exec(match)?.[0] ?? '';
        const token = trailing ? match.slice(0, -trailing.length) : match;
        return matches(token) ? `${SERVER_MARKER}${trailing}` : match;
      });
  }
  for (const host of hosts) {
    result = result.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(host)}(?![\\w-])`, 'giu'), SERVER_MARKER);
  }
  return result;
}
