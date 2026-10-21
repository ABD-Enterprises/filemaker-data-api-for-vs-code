import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { createDiagnosticProbes } from '../../src/services/connectionDiagnostics';
import { FMClient } from '../../src/services/fmClient';
import type { ConnectionProfile } from '../../src/types/fm';

const profile: ConnectionProfile = { id: 'p', name: 'Office', serverUrl: 'https://fm.example.test', database: 'DB', authMode: 'direct', username: 'admin' };
function client() {
  const request = vi.fn().mockResolvedValue({ status: 200, data: { response: { productInfo: { name: 'FileMaker Server', version: '22' } }, messages: [{ code: '0', message: 'OK' }] } });
  const secrets = { getPassword: vi.fn(), getToken: vi.fn(), getProxyApiKey: vi.fn() };
  const fm = new FMClient(secrets as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 5000, { request } as never);
  return { fm, request, secrets };
}

describe('diagnosis uses the real FMClient unauthenticated transport', () => {
  it('reports actual HTTP status and envelope code, without session or credential access', async () => {
    const { fm, request, secrets } = client();
    request.mockResolvedValueOnce({ status: 201, data: { response: { productInfo: { name: 'Server', version: '23' } }, messages: [{ code: '0' }] } });
    const signal = new AbortController().signal;
    expect(await createDiagnosticProbes(fm).product(profile, signal)).toEqual({ status: 201, code: '0', name: 'Server', version: '23' });
    const options = request.mock.calls[0]![0];
    expect(options).toMatchObject({ method: 'GET', url: 'https://fm.example.test/fmi/data/vLatest/productInfo', headers: { Accept: 'application/json' }, maxRedirects: 0, signal, timeout: 5000 });
    expect(options.signal).toBe(signal);
    expect(options.headers).toEqual({ Accept: 'application/json' });
    expect(options.auth).toBeUndefined(); expect(secrets.getPassword).not.toHaveBeenCalled(); expect(secrets.getToken).not.toHaveBeenCalled(); expect(secrets.getProxyApiKey).not.toHaveBeenCalled();
  });
  it('uses the path prefix in the real unauthenticated request', async () => {
    const { fm, request } = client();
    await createDiagnosticProbes(fm).product({ ...profile, serverUrl: 'https://fm.example.test/fm' }, new AbortController().signal);
    expect(request.mock.calls[0]![0].url).toBe('https://fm.example.test/fm/fmi/data/vLatest/productInfo');
  });
  it('retains HTTP/FileMaker errors without starting another uncancellable certificate inspection', async () => {
    const { fm, request } = client();
    request.mockResolvedValueOnce({ status: 200, data: { response: {}, messages: [{ code: '802', message: 'Unavailable' }] } });
    await expect(fm.getProductInfoDiagnostics(profile)).rejects.toMatchObject({ status: 200, code: '802' });
    const refine = vi.spyOn(fm as never as { refineCertificateError: () => Promise<never> }, 'refineCertificateError');
    request.mockRejectedValueOnce(new axios.AxiosError('certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'));
    await expect(fm.getProductInfoDiagnostics(profile)).rejects.toMatchObject({ networkCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(refine).not.toHaveBeenCalled();
  });
  it('refuses a non-Data-API success without printing the body', async () => {
    const { fm, request } = client(); request.mockResolvedValueOnce({ status: 200, data: '<html>proxy sign-in</html>' });
    await expect(fm.getProductInfoDiagnostics(profile)).rejects.toMatchObject({ status: 200, code: 'NOT_DATA_API_RESPONSE' });
  });
});
