import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CertificateInspect from '../../src/services/certificateInspect';

const inspect = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/certificateInspect', async (importOriginal) => ({
  ...(await importOriginal<typeof CertificateInspect>()),
  inspectServerCertificate: inspect
}));

import { FMClientError } from '../../src/services/errors';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { InMemorySecretStorage } from './mocks';

type Refiner = (profile: unknown, failure: unknown) => Promise<FMClientError>;

describe('the extra certificate look after an untrusted-certificate failure', () => {
  const saved = { ...process.env };
  let clock: number;
  let refine: Refiner;
  const profile = { id: 'p', name: 'p', authMode: 'direct', serverUrl: 'https://fm.example.com', database: 'D' };
  const failure = (code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'): FMClientError => new FMClientError('x', { kind: 'certificate', networkCode: code } as never);

  beforeEach(() => {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key];
    inspect.mockReset();
    clock = 1_000_000;
    const fm = new FMClient(
      new SecretStore(new InMemorySecretStorage() as never),
      { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      500,
      undefined,
      undefined,
      undefined,
      undefined,
      { now: () => clock }
    ) as unknown as { refineCertificateError: Refiner };
    refine = fm.refineCertificateError.bind(fm);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('looks once for repeated failures of the same server, then again after a minute', async () => {
    inspect.mockResolvedValue({ altNames: [], issuer: 'FileMaker', subject: 'FileMaker' });
    await refine(profile, failure());
    await refine(profile, failure());
    await Promise.all([refine(profile, failure()), refine(profile, failure())]);
    expect(inspect).toHaveBeenCalledTimes(1);

    clock += 61_000;
    await refine(profile, failure());
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('a look that fails is remembered too, so a silent server does not cost the full wait every time', async () => {
    inspect.mockRejectedValue(new Error('timeout'));
    const first = failure();
    expect(await refine(profile, first)).toBe(first);
    expect(await refine(profile, first)).toBe(first);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('a different failure code or server gets its own look', async () => {
    inspect.mockRejectedValue(new Error('timeout'));
    await refine(profile, failure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
    await refine(profile, failure('DEPTH_ZERO_SELF_SIGNED_CERT'));
    await refine({ ...profile, serverUrl: 'https://other.example.com' }, failure());
    expect(inspect).toHaveBeenCalledTimes(3);
  });
});
