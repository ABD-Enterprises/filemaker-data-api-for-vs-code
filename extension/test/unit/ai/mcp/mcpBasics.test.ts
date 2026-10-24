import { describe, expect, it } from 'vitest';

import { HELLO_ACK, helloLine, newToken, parseHello, tokensMatch } from '../../../../src/ai/mcp/auth';
import { FrameTooLargeError, LineSplitter, encodeLine } from '../../../../src/ai/mcp/framing';
import { getProcessStartTime, isProcessAlive } from '../../../../src/ai/mcp/processInfo';
import { RateLimiter } from '../../../../src/ai/mcp/rateLimiter';

describe('LineSplitter', () => {
  it('splits lines across chunks, trims CR, and drops empty lines', () => {
    const splitter = new LineSplitter(100);
    expect(splitter.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(splitter.push(Buffer.from(':2}\r\n\n\n{"c":3}\n'))).toEqual(['{"b":2}', '{"c":3}']);
    expect(splitter.pendingBytes()).toBe(0);
  });

  it('keeps multi-byte characters intact when a chunk ends inside one', () => {
    const splitter = new LineSplitter(100);
    const bytes = Buffer.from('"顧客"\n');
    expect(splitter.push(bytes.subarray(0, 3))).toEqual([]);
    expect(splitter.push(bytes.subarray(3))).toEqual(['"顧客"']);
  });

  it('refuses a line over the limit, whether it has ended or is still arriving', () => {
    expect(() => new LineSplitter(10).push(Buffer.from('x'.repeat(11) + '\n'))).toThrow(FrameTooLargeError);
    const splitter = new LineSplitter(10);
    expect(splitter.push(Buffer.from('x'.repeat(10)))).toEqual([]);
    expect(() => splitter.push(Buffer.from('y'))).toThrow(FrameTooLargeError);
  });

  it('accepts a line of exactly the limit', () => {
    expect(new LineSplitter(10).push(Buffer.from('x'.repeat(10) + '\n'))).toEqual(['x'.repeat(10)]);
  });
});

describe('encodeLine', () => {
  it('writes one line, even for text with line separators', () => {
    const line = encodeLine({ text: 'a\nb\u2028c' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ text: 'a\nb\u2028c' });
  });
});

describe('RateLimiter', () => {
  it('allows max events per window and recovers when the window moves', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false]);
    now = 999;
    expect(limiter.take()).toBe(false);
    now = 1000;
    expect(limiter.take()).toBe(true);
  });
});

describe('auth', () => {
  it('makes 256-bit hex tokens that differ', () => {
    const a = newToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(a);
  });

  it('compares tokens exactly, whatever their length', () => {
    const token = newToken();
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(token, `${token}0`)).toBe(false);
    expect(tokensMatch(token, token.slice(0, -1))).toBe(false);
    expect(tokensMatch(token, '')).toBe(false);
    expect(tokensMatch(token, newToken())).toBe(false);
  });

  it('parses only a strict hello line', () => {
    const token = newToken();
    expect(parseHello(helloLine(token).trim())).toEqual({ token });
    for (const bad of [
      '',
      'hello',
      '{}',
      '{"hello":"ok"}',
      '{"hello":{"protocol":2,"token":"x"}}',
      '{"hello":{"protocol":1}}',
      '{"hello":{"protocol":1,"token":5}}',
      '{"hello":{"protocol":1,"token":"x","extra":1}}',
      '{"hello":{"protocol":1,"token":"x"},"jsonrpc":"2.0"}',
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      `{"hello":{"protocol":1,"token":"${'a'.repeat(600)}"}}`
    ]) {
      expect(parseHello(bad), bad.slice(0, 40)).toBeUndefined();
    }
    expect(HELLO_ACK).toBe('{"hello":"ok"}');
  });
});

describe('process identity', () => {
  // Two Windows lookups can each use the full 30-second PowerShell timeout.
  it('knows this process is alive and has a start time that is stable', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const first = await getProcessStartTime(process.pid);
    expect(first).toBeTruthy();
    expect(await getProcessStartTime(process.pid)).toBe(first);
  }, 75_000);
});
