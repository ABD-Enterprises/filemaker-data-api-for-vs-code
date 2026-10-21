import { describe, expect, it, vi, afterEach } from 'vitest';

import { buildDiagnosticReport, certificateExpiry, matchCertificateName, rankDiagnosticCauses, runConnectionDiagnostics, type CertificateFacts, type DiagnosticProbes, type DiagnosticReport, type NetworkSettings } from '../../src/services/connectionDiagnostics';
import { FMClientError } from '../../src/services/errors';
import type { ConnectionProfile } from '../../src/types/fm';

const profile: ConnectionProfile = { id: 'p', name: 'Server', serverUrl: 'https://fm.example.test', authMode: 'direct', database: 'DB' };
const settings: NetworkSettings = { proxySupport: 'fallback', proxyConfigured: false, systemCertificates: true, proxyVariables: [], hostReplaced: false };
const certificate: CertificateFacts = {
  subject: 'CN=fm.example.test', issuer: 'CN=Example CA', serial: '01', validFrom: 'Jan 1 2020 GMT', validTo: 'Jan 1 2040 GMT',
  fingerprint: 'a'.repeat(64), altNames: 'DNS:fm.example.test', chainBeyondLeaf: true, selfSigned: false, protocol: 'TLSv1.3', cipher: 'AES',
  expired: false, notYetValid: false, nameMatch: true, noNames: false
};
const base = (): DiagnosticReport => ({ address: profile.serverUrl, steps: [], certificate: { ...certificate }, verified: true, pin: 'none' });
const fail = (name: string) => ({ name, verdict: 'FAIL' as const, ms: 4, text: 'Failed' });
function probes(): DiagnosticProbes {
  return { dns: vi.fn().mockResolvedValue('127.0.0.1'), tcp: vi.fn().mockResolvedValue(undefined), certificate: vi.fn().mockResolvedValue({ ...certificate }), verify: vi.fn().mockResolvedValue(undefined), product: vi.fn().mockResolvedValue({ status: 200, code: '0', name: 'FileMaker Server', version: '22' }) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('diagnostic causes (the mock TLS modes are the oracle)', () => {
  it.each([
    ['cancelled', { cancelled: true }, /Check cancelled/],
    ['invalid address', { steps: [fail('Address')] }, /Fix the Server URL/],
    ['DNS', { steps: [fail('DNS')] }, /name could not be found/],
    ['TCP', { steps: [fail('TCP')] }, /port cannot be reached/],
    ['changed pin', { pin: 'mismatch' }, /fingerprint does not match/],
    ['invalid pin', { pin: 'invalid' }, /fingerprint does not match/],
    ['expired', { certificate: { ...certificate, expired: true } }, /expired on Jan 1 2040/],
    ['notyet', { certificate: { ...certificate, notYetValid: true } }, /not valid until Jan 1 2020/],
    ['proxy', { pin: 'match', environmentProxy: true }, /NO_PROXY/],
    ['VS Code override with pin', { pin: 'match', hostReplaced: true }, /http.proxySupport to fallback/],
    ['VS Code override with untrusted certificate', { verified: false, hostReplaced: true }, /http.proxySupport to fallback/],
    ['claris-default-cert', { verified: false, certificate: { ...certificate, noNames: true, nameMatch: false, chainBeyondLeaf: false } }, /No host names listed.*trust it by fingerprint.*aaaaaaaaaaaa/],
    ['wronghost', { verified: false, certificate: { ...certificate, nameMatch: false } }, /different server name/],
    ['untrusted CA', { verified: false }, /CA file or a public certificate/],
    ['self-signed', { verified: false, certificate: { ...certificate, selfSigned: true } }, /self-signed/],
    ['TLS unavailable', { certificate: undefined, steps: [fail('TLS')] }, /supported TLS version/],
    ['Data API HTTP error', { steps: [fail('Data API')], http: 503, fmCode: '802' }, /HTTP 503.*FileMaker 802/],
    ['Data API no response', { steps: [fail('Data API')] }, /Data API did not answer/],
    ['HTTP', { certificate: undefined, steps: [{ name: 'Address', verdict: 'WARN', ms: 0, text: 'HTTP' }] }, /HTTP without encryption/],
    ['good', {}, /checks passed without signing in/],
    ['matching trusted default', { pin: 'match', verified: false, certificate: { ...certificate, noNames: true, nameMatch: false } }, /presents the fingerprint you trusted/]
  ] as Array<[string, Partial<DiagnosticReport>, RegExp]>)('%s gives an actionable cause', (_name, extra, expected) => {
    expect(rankDiagnosticCauses({ ...base(), ...extra })[0]).toMatch(expected);
  });
  it('ranks causes, gives at most three, and does not suggest a CA file for the Claris default', () => {
    const report = { ...base(), steps: [fail('TCP')], pin: 'mismatch' as const, hostReplaced: true, verified: false, certificate: { ...certificate, expired: true, noNames: true, nameMatch: false } };
    const causes = rankDiagnosticCauses(report);
    expect(causes).toHaveLength(3);
    expect(causes[0]).toMatch(/port cannot be reached/);
    expect(causes[1]).toMatch(/fingerprint does not match/);
    expect(causes[2]).toMatch(/expired/);
    expect(rankDiagnosticCauses({ ...base(), verified: false, certificate: { ...certificate, noNames: true, nameMatch: false } }).join(' ')).not.toContain('CA file');
  });
});

describe('certificate facts', () => {
  it.each([
    ['fm.example.test', 'DNS:fm.example.test', undefined, true, false],
    ['one.example.test', 'DNS:*.example.test', undefined, true, false],
    ['two.one.example.test', 'DNS:*.example.test', undefined, false, false],
    ['example.test', 'DNS:*.example.test', undefined, false, false],
    ['fm.example.test', 'DNS:other.test', 'fm.example.test', false, false],
    ['fm.example.test', '', 'fm.example.test', true, false],
    ['fm.example.test', '', 'Claris Self Signed Certificate (Not for Production Use)', false, true],
    ['fm.example.test', '', undefined, false, true],
    ['127.0.0.1', 'IP Address:127.0.0.1', undefined, true, false],
    ['127.0.0.2', 'IP Address:127.0.0.1', undefined, false, false],
    ['127.0.0.1', 'DNS:127.0.0.1', '127.0.0.1', false, false],
    ['[::1]', 'IP Address:0:0:0:0:0:0:0:1', undefined, true, false],
    ['127.0.0.1', 'DNS:"evil, IP Address:127.0.0.1"', undefined, false, false],
    ['127.0.0.1', 'IP Address:127.0.0.1evil', undefined, false, false]
  ] as Array<[string, string, string | undefined, boolean, boolean]>)('matches %s against %s', (host, san, cn, nameMatch, noNames) => {
    expect(matchCertificateName(host, san, cn)).toEqual({ nameMatch, noNames });
  });
  it('checks validity dates, including exact boundaries', () => {
    expect(certificateExpiry('2020-01-01', '2021-01-01', Date.parse('2022-01-01'))).toEqual({ expired: true, notYetValid: false });
    expect(certificateExpiry('2030-01-01', '2031-01-01', Date.parse('2022-01-01'))).toEqual({ expired: false, notYetValid: true });
    expect(certificateExpiry('2020-01-01', '2021-01-01', Date.parse('2020-01-01'))).toEqual({ expired: false, notYetValid: false });
    expect(certificateExpiry('2020-01-01', '2021-01-01', Date.parse('2021-01-01'))).toEqual({ expired: false, notYetValid: false });
  });
});

describe('ordered, bounded, unauthenticated diagnosis', () => {
  it('runs every step, keeps certificate details and compares the pin', async () => {
    const fake = probes();
    const report = await runConnectionDiagnostics({ ...profile, pinnedCertSha256: certificate.fingerprint }, settings, fake, new AbortController().signal);
    expect(report.steps.map((step) => step.name)).toEqual(['Address', 'DNS', 'TCP', 'TLS', 'Certificate verification', 'Trusted fingerprint', 'VS Code network settings', 'Data API']);
    expect(report.steps.every((step) => step.ms >= 0 && step.verdict === 'PASS')).toBe(true);
    expect(report.pin).toBe('match');
    const text = buildDiagnosticReport(report);
    for (const value of ['TLSv1.3', 'AES', 'Example CA', 'Serial: 01', 'Jan 1 2040', certificate.fingerprint, 'Chain beyond the leaf: yes', 'Self-signed: no', 'version: unavailable', 'HTTP 200', 'FileMaker code 0', 'FileMaker Server']) expect(text).toContain(value);
    expect(fake.product).toHaveBeenCalledWith(expect.objectContaining({ apiBasePath: '/fmi/data', apiVersionPath: 'vLatest' }), expect.any(AbortSignal));
  });
  it.each(['mismatch', 'invalid', 'none'] as const)('reports %s pins', async (pin) => {
    const report = await runConnectionDiagnostics({ ...profile, pinnedCertSha256: pin === 'none' ? undefined : pin === 'invalid' ? 'bad' : 'b'.repeat(64) }, settings, probes(), new AbortController().signal);
    expect(report.pin).toBe(pin);
    expect(report.steps.find((s) => s.name === 'Trusted fingerprint')?.verdict).toBe(pin === 'none' ? 'PASS' : 'FAIL');
  });
  it.each(['ftp://host', 'https://host:0', 'https://host:70000', 'garbage', 'https://user:secret@host', 'https://host?token=secret', 'https://host/sessions/secret'])('rejects %s before any probe', async (address) => {
    const fake = probes();
    const report = await runConnectionDiagnostics({ ...profile, serverUrl: address }, settings, fake, new AbortController().signal);
    expect(report.steps[0]?.verdict).toBe('FAIL');
    expect(fake.dns).not.toHaveBeenCalled(); expect(fake.product).not.toHaveBeenCalled();
    expect(buildDiagnosticReport(report)).not.toContain('secret');
  });
  it('handles IPs and warns on HTTP without making a TLS connection', async () => {
    const fake = probes();
    const report = await runConnectionDiagnostics({ ...profile, serverUrl: 'http://127.0.0.1:80' }, settings, fake, new AbortController().signal);
    expect(report.steps[0]?.verdict).toBe('WARN'); expect(report.steps[1]?.text).toContain('IP address');
    expect(fake.dns).not.toHaveBeenCalled(); expect(fake.certificate).not.toHaveBeenCalled(); expect(fake.verify).not.toHaveBeenCalled();
    expect(fake.tcp).toHaveBeenCalledWith('127.0.0.1', 80, expect.any(AbortSignal));
  });
  it('continues with useful later checks after a probe fails, and reports HTTP/FileMaker failures', async () => {
    const fake = probes();
    vi.mocked(fake.dns).mockRejectedValue({ code: 'ENOTFOUND' });
    vi.mocked(fake.verify).mockRejectedValue({ code: 'CERT_HAS_EXPIRED' });
    vi.mocked(fake.product).mockRejectedValue(new FMClientError('Cookie: never-show-this', { status: 503, code: '802' }));
    const report = await runConnectionDiagnostics(profile, settings, fake, new AbortController().signal);
    expect(report.verified).toBe(false);
    expect(report.steps[1]?.text).toContain('ENOTFOUND');
    expect(report.steps.find((s) => s.name === 'TLS')?.verdict).toBe('WARN');
    expect(report.steps.at(-1)?.text).toContain('HTTP 503; FileMaker code 802');
    expect(buildDiagnosticReport(report)).not.toContain('never-show-this');
  });
  it('does not print environment proxy values, headers, credential fields or raw failures', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy-user:proxy-password@proxy.example.test:9');
    const fake = probes();
    const unsafe = { ...profile, password: 'password-secret', token: 'token-secret', apiKey: 'api-key-secret', username: 'user-secret' };
    vi.mocked(fake.product).mockRejectedValue({ status: 403, code: '212', headers: { Cookie: 'cookie-secret' }, message: 'raw-secret' });
    const report = await runConnectionDiagnostics(unsafe, { ...settings, proxyConfigured: true, proxyVariables: ['HTTPS_PROXY'], hostReplaced: true }, fake, new AbortController().signal);
    const text = buildDiagnosticReport(report);
    for (const secret of ['password-secret', 'token-secret', 'api-key-secret', 'user-secret', 'cookie-secret', 'raw-secret', 'proxy-user', 'proxy-password']) expect(text).not.toContain(secret);
    expect(text).toContain('HTTPS_PROXY'); expect(text).toContain('values hidden'); expect(text).toContain('does not work around it');
  });
  it('redacts server text and safely quotes Markdown; masking also hides SAN and subject names', async () => {
    const fake = probes();
    vi.mocked(fake.product).mockResolvedValue({ status: 200, code: '0', name: 'Bearer secretABC', version: '22' });
    const report = await runConnectionDiagnostics(profile, settings, fake, new AbortController().signal);
    report.steps.push({ name: 'Test', verdict: 'WARN', ms: 0, text: '[open](command:evil)\n# PASS\nFM.EXAMPLE.TEST\nCookie: cookieABC' });
    const text = buildDiagnosticReport(report);
    expect(text).not.toContain('secretABC'); expect(text).not.toContain('cookieABC'); expect(text).not.toContain('[open]'); expect(text).not.toContain('\n# PASS');
    const hidden = buildDiagnosticReport(report, true);
    expect(hidden).not.toContain('fm.example.test'); expect(hidden).not.toContain('FM.EXAMPLE.TEST'); expect(hidden).not.toContain('Example CA'); expect(hidden).toContain('(hidden)');
  });
  it('cancels a running probe and never starts another', async () => {
    const fake = probes(); const controller = new AbortController(); let active: AbortSignal | undefined;
    fake.tcp = vi.fn((_host, _port, s) => { active = s; return new Promise<void>(() => undefined); });
    const run = runConnectionDiagnostics(profile, settings, fake, controller.signal);
    await vi.waitFor(() => expect(fake.tcp).toHaveBeenCalled()); controller.abort();
    const report = await run;
    expect(active?.aborted).toBe(true); expect(report.cancelled).toBe(true); expect(fake.certificate).not.toHaveBeenCalled();
  });
  it('times out a stalled DNS lookup and aborts the probe', async () => {
    vi.useFakeTimers(); const fake = probes(); let active: AbortSignal | undefined;
    fake.dns = vi.fn((_host, s) => { active = s; return new Promise<string>(() => undefined); });
    const run = runConnectionDiagnostics(profile, settings, fake, new AbortController().signal, 50);
    await vi.advanceTimersByTimeAsync(51);
    const report = await run;
    expect(active?.aborted).toBe(true); expect(report.steps[1]?.text).toContain('ETIMEDOUT');
  });
  it('does not start probes for an already cancelled operation', async () => {
    const fake = probes(); const controller = new AbortController(); controller.abort();
    expect((await runConnectionDiagnostics(profile, settings, fake, controller.signal)).cancelled).toBe(true);
    expect(fake.dns).not.toHaveBeenCalled(); expect(fake.tcp).not.toHaveBeenCalled();
  });
});
