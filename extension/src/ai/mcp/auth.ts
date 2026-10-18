import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export const HELLO_PROTOCOL = 1;
export const HELLO_ACK = '{"hello":"ok"}';
const MAX_HELLO_BYTES = 512;

/** A per-session secret: 256 random bits, hex. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Compares two tokens in constant time whatever their lengths: both are hashed first, so the
 * comparison always runs over two 32-byte digests.
 */
export function tokensMatch(expected: string, given: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(given, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** The first line a client sends on a new connection. */
export function helloLine(token: string): string {
  return `${JSON.stringify({ hello: { protocol: HELLO_PROTOCOL, token } })}\n`;
}

/** Strict parse of the hello line; anything else is not a hello. */
export function parseHello(line: string): { token: string } | undefined {
  if (line.length > MAX_HELLO_BYTES) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as { hello?: { protocol?: unknown; token?: unknown } };
    const hello = parsed?.hello;
    if (
      hello &&
      typeof hello === 'object' &&
      hello.protocol === HELLO_PROTOCOL &&
      typeof hello.token === 'string' &&
      Object.keys(parsed).length === 1 &&
      Object.keys(hello).length === 2
    ) {
      return { token: hello.token };
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}
