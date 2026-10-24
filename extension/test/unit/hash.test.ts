import { describe, it, expect } from 'vitest';

import { hashObject, stableStringify, hashObjectWithAlgorithm } from '../../src/utils/hash';

describe('stableStringify', () => {
  it('serializes objects with sorted keys', () => {
    const a = stableStringify({ b: 2, a: 1 });
    const b = stableStringify({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('handles nested objects', () => {
    const result = stableStringify({ outer: { z: 3, a: 1 } });
    expect(result).toContain('"a"');
    expect(result).toContain('"z"');
  });

  it('handles arrays', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
  });

  it('handles primitives', () => {
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
  });

  it('handles empty objects and arrays', () => {
    expect(stableStringify({})).toBe('{}');
    expect(stableStringify([])).toBe('[]');
  });
});

describe('hashObject', () => {
  it('returns deterministic sha256 hex hash', () => {
    const h1 = hashObject({ name: 'test' });
    const h2 = hashObject({ name: 'test' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = hashObject({ a: 1 });
    const h2 = hashObject({ a: 2 });
    expect(h1).not.toBe(h2);
  });

  it('is key-order independent', () => {
    const h1 = hashObject({ b: 2, a: 1 });
    const h2 = hashObject({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });
});

describe('hashObjectWithAlgorithm', () => {
  it('falls back to sha256 on invalid algorithm', () => {
    const result = hashObjectWithAlgorithm({ x: 1 }, 'nonexistent-algo');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
