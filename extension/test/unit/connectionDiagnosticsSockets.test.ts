import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tls from 'node:tls';
import * as net from 'node:net';

import { createDiagnosticProbes, runConnectionDiagnostics } from '../../src/services/connectionDiagnostics';
import * as agents from '../../src/services/tlsAgent';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';

vi.mock('node:tls', async (original) => ({ ...await original<typeof tls>(), connect: vi.fn() }));
vi.mock('node:net', async (original) => ({ ...await original<typeof net>(), connect: vi.fn() }));

const profile = { id: 'p', name: 'Office', serverUrl: 'https://127.0.0.1', authMode: 'direct' as const, database: 'DB' };
const certificate = makeCertificate({ subjectCn: 'localhost', altNames: ['localhost', 'IP:127.0.0.1'], notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: newKeyPair() });
function socket() {
  const peer = { raw: certificate.der, subject: { CN: 'localhost' } };
  return Object.assign(new EventEmitter(), {
    destroy: vi.fn(), write: vi.fn(), getPeerCertificate: () => peer, getProtocol: () => 'TLSv1.3', getCipher: () => ({ name: 'AES' })
  });
}
const client = { getProductInfoDiagnostics: vi.fn().mockResolvedValue({ status: 200, code: '0' }) };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('real probe adapters without opening sockets', () => {
  it('reads a certificate over TLS without any HTTP bytes, then closes the socket', async () => {
    const peer = socket(); vi.mocked(tls.connect).mockReturnValue(peer as never);
    const result = createDiagnosticProbes(client).certificate('localhost', 443, new AbortController().signal);
    expect(tls.connect).toHaveBeenCalledWith({ host: 'localhost', port: 443, servername: 'localhost', rejectUnauthorized: false, ca: [] });
    expect(peer.write).not.toHaveBeenCalled(); peer.emit('secureConnect');
    expect(await result).toMatchObject({ selfSigned: true, nameMatch: true, noNames: false, chainBeyondLeaf: false, fingerprint: agents.normalizeSha256(certificate.fingerprint256) });
    expect(peer.destroy).toHaveBeenCalled(); expect(peer.write).not.toHaveBeenCalled();
  });
  it('strictly verifies with tlsAgent CA policy even for a pinned or legacy profile', async () => {
    const peer = socket(); vi.mocked(tls.connect).mockReturnValue(peer as never);
    const agent = vi.spyOn(agents, 'createHttpsAgentForProfile').mockReturnValue({ options: { ca: ['configured-root'], rejectUnauthorized: false } } as never);
    const result = createDiagnosticProbes(client).verify('127.0.0.1', 8443, { ...profile, caBundlePath: '/ca.pem', pinnedCertSha256: 'a'.repeat(64), allowSelfSigned: true }, new AbortController().signal);
    expect(agent).toHaveBeenCalledWith({ caBundlePath: '/ca.pem' });
    expect(tls.connect).toHaveBeenCalledWith({ ca: ['configured-root'], rejectUnauthorized: true, host: '127.0.0.1', port: 8443, servername: undefined });
    peer.emit('secureConnect'); await result; expect(peer.write).not.toHaveBeenCalled(); expect(peer.destroy).toHaveBeenCalled();
  });
  it('closes cancelled sockets and removes the abort listener', async () => {
    const peer = socket(); vi.mocked(net.connect).mockReturnValue(peer as never);
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = createDiagnosticProbes(client).tcp('localhost', 443, controller.signal);
    controller.abort(); peer.emit('close');
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(peer.destroy).toHaveBeenCalled(); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('closes failed TLS handshakes', async () => {
    const peer = socket(); vi.mocked(tls.connect).mockReturnValue(peer as never);
    const result = createDiagnosticProbes(client).verify('localhost', 443, profile, new AbortController().signal);
    peer.emit('error', Object.assign(new Error('expired'), { code: 'CERT_HAS_EXPIRED' }));
    await expect(result).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' }); expect(peer.destroy).toHaveBeenCalled();
  });
  it('closes a stalled TCP socket on its absolute deadline', async () => {
    vi.useFakeTimers();
    const peer = socket(); vi.mocked(net.connect).mockReturnValue(peer as never);
    const real = createDiagnosticProbes(client);
    real.certificate = vi.fn().mockRejectedValue({ code: 'TLS_FAILED' });
    real.verify = vi.fn().mockRejectedValue({ code: 'TLS_FAILED' });
    const result = runConnectionDiagnostics(profile, { proxySupport: 'off', proxyConfigured: false, systemCertificates: false, proxyVariables: [], hostReplaced: false }, real, new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(21);
    const report = await result;
    expect(peer.destroy).toHaveBeenCalled(); expect(report.steps.find((step) => step.name === 'TCP')?.text).toContain('ETIMEDOUT');
  });
});
