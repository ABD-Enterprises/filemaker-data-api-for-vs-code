import { describe, expect, it, vi } from 'vitest';

import { SettingsService } from '../../../src/services/settingsService';

interface FakeConfig {
  get<T>(section: string, defaultValue: T): T;
}

function makeService(configured: unknown): SettingsService {
  const config: FakeConfig = {
    get<T>(_section: string, defaultValue: T): T {
      return configured === undefined ? defaultValue : (configured as T);
    }
  };
  return new SettingsService({
    getConfiguration: () => config as never,
    isWorkspaceTrusted: () => true
  });
}

describe('SettingsService.getSchemaHashAlgorithm', () => {
  it('returns sha256 by default when nothing configured', () => {
    expect(makeService(undefined).getSchemaHashAlgorithm()).toBe('sha256');
  });

  it('accepts a supported algorithm', () => {
    // sha256 is universally supported; sha512 is too on Node's openssl.
    expect(makeService('sha256').getSchemaHashAlgorithm()).toBe('sha256');
    expect(makeService('sha512').getSchemaHashAlgorithm()).toBe('sha512');
  });

  it('falls back to sha256 for an unknown algorithm and fires the warning callback', () => {
    const onInvalid = vi.fn();
    const result = makeService('not-a-real-hash').getSchemaHashAlgorithm(onInvalid);
    expect(result).toBe('sha256');
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid).toHaveBeenCalledWith('not-a-real-hash');
  });

  it('does not fire the warning callback when no callback is provided', () => {
    expect(() => makeService('not-a-real-hash').getSchemaHashAlgorithm()).not.toThrow();
  });

  it('treats empty string as default (no warning)', () => {
    const onInvalid = vi.fn();
    expect(makeService('').getSchemaHashAlgorithm(onInvalid)).toBe('sha256');
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('comparison is case-insensitive', () => {
    // Node returns lowercase names from getHashes(); a user could enter mixed case.
    const result = makeService('SHA256').getSchemaHashAlgorithm();
    expect(result).toBe('SHA256');
  });
});
