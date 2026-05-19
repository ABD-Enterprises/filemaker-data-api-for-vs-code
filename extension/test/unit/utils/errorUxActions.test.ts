import { describe, expect, it } from 'vitest';

import { selectErrorActions } from '../../../src/utils/errorUx';

describe('selectErrorActions', () => {
  it('returns nothing when no actions provided', () => {
    expect(selectErrorActions({ kind: 'unknown' }, undefined)).toEqual([]);
    expect(selectErrorActions({ kind: 'auth' }, {})).toEqual([]);
  });

  it('offers Retry for transient errors when a retry callback is provided', () => {
    const retry = async () => {};
    expect(selectErrorActions({ kind: 'timeout', isRetryable: true }, { retry })).toContain('Retry');
    expect(selectErrorActions({ kind: 'network', isRetryable: true }, { retry })).toContain('Retry');
    expect(selectErrorActions({ kind: 'server', status: 503 }, { retry })).toContain('Retry');
  });

  it('does not offer Retry for non-transient errors', () => {
    const retry = async () => {};
    expect(selectErrorActions({ kind: 'auth', status: 401 }, { retry })).not.toContain('Retry');
    expect(selectErrorActions({ kind: 'validation' }, { retry })).not.toContain('Retry');
  });

  it('offers Edit Profile on auth errors when profileId is provided', () => {
    expect(
      selectErrorActions({ kind: 'auth', status: 401 }, { profileId: 'p1' })
    ).toContain('Edit Profile');
    expect(
      selectErrorActions({ kind: 'server', status: 403 }, { profileId: 'p1' })
    ).toContain('Edit Profile');
  });

  it('does not offer Edit Profile on non-auth errors', () => {
    expect(
      selectErrorActions({ kind: 'timeout' }, { profileId: 'p1' })
    ).not.toContain('Edit Profile');
  });

  it('offers Open Settings on timeout errors when a settingsKey is provided', () => {
    expect(
      selectErrorActions(
        { kind: 'timeout', isRetryable: true },
        { settingsKey: 'filemaker.requestTimeoutMs' }
      )
    ).toContain('Open Settings');
  });

  it('does not offer Open Settings on non-timeout errors', () => {
    expect(
      selectErrorActions({ kind: 'auth' }, { settingsKey: 'filemaker.requestTimeoutMs' })
    ).not.toContain('Open Settings');
  });

  it('combines Retry + Open Settings on a timeout that is also retryable', () => {
    const retry = async () => {};
    const actions = selectErrorActions(
      { kind: 'timeout', isRetryable: true },
      { retry, settingsKey: 'filemaker.requestTimeoutMs' }
    );
    expect(actions).toEqual(['Retry', 'Open Settings']);
  });

  it('combines Retry + Edit Profile on a 401 marked retryable', () => {
    const retry = async () => {};
    const actions = selectErrorActions(
      { kind: 'auth', status: 401, isRetryable: true },
      { retry, profileId: 'p1' }
    );
    expect(actions).toEqual(['Retry', 'Edit Profile']);
  });
});
