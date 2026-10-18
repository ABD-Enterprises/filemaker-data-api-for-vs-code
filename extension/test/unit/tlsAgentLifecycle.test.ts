import { mkdtemp, utimes, writeFile } from 'fs/promises';
import { createServer, get, type Server } from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PinnedCertificateAgent,
  RETIRED_AGENT_GRACE_MS,
  createHttpsAgentForProfile,
  disposeTlsAgents,
  normalizeSha256
} from '../../src/services/tlsAgent';
import { DAY, keyToPem, makeCertificate, newKeyPair } from '../helpers/x509';

const pem = (cn: string): string =>
  makeCertificate({ subjectCn: cn, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: newKeyPair() }).pem;

describe('agents that are replaced or evicted are closed', () => {
  afterEach(() => {
    vi.useRealTimers();
    disposeTlsAgents();
  });

  it('closes the agent made for an earlier version of an edited CA file, after a grace period for running requests', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'fm-life-'));
    const caPath = join(root, 'ca.pem');
    await writeFile(caPath, pem('one'), 'utf8');
    const first = createHttpsAgentForProfile({ caBundlePath: caPath });
    const destroyFirst = vi.spyOn(first, 'destroy');

    await writeFile(caPath, `${pem('two')}${pem('three')}`, 'utf8');
    await utimes(caPath, new Date(), new Date(Date.now() + 5000));
    const second = createHttpsAgentForProfile({ caBundlePath: caPath });
    const destroySecond = vi.spyOn(second, 'destroy');

    expect(second).not.toBe(first);
    expect(destroyFirst).not.toHaveBeenCalled(); // a request already running on it is not cut off
    vi.advanceTimersByTime(RETIRED_AGENT_GRACE_MS - 1);
    expect(destroyFirst).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(destroyFirst).toHaveBeenCalledTimes(1);
    expect(destroySecond).not.toHaveBeenCalled(); // the current agent stays
    expect(createHttpsAgentForProfile({ caBundlePath: caPath })).toBe(second);
  });

  it('keeps the number of cached agents bounded: the oldest is retired, newer ones stay', () => {
    vi.useFakeTimers();
    const pins = Array.from({ length: 40 }, (_, i) => normalizeSha256(i.toString(16).padStart(2, '0').repeat(32)) as string);
    const agents = pins.map((pin) => createHttpsAgentForProfile({ pinnedCertSha256: pin }));
    const spies = agents.map((agent) => vi.spyOn(agent, 'destroy'));

    vi.advanceTimersByTime(RETIRED_AGENT_GRACE_MS);

    const destroyed = spies.filter((spy) => spy.mock.calls.length > 0).length;
    expect(destroyed).toBe(8); // 40 made, 32 kept
    expect(spies.slice(0, 8).every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(spies.slice(8).every((spy) => spy.mock.calls.length === 0)).toBe(true);
    // A retired setting simply gets a fresh agent when it is used again.
    expect(createHttpsAgentForProfile({ pinnedCertSha256: pins[0] })).not.toBe(agents[0]);
    expect(createHttpsAgentForProfile({ pinnedCertSha256: pins[39] })).toBe(agents[39]);
  });

  it('disposeTlsAgents closes everything at once and forgets it', () => {
    const agent = createHttpsAgentForProfile({ pinnedCertSha256: 'cd'.repeat(32) });
    const destroy = vi.spyOn(agent, 'destroy');
    disposeTlsAgents();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(createHttpsAgentForProfile({ pinnedCertSha256: 'cd'.repeat(32) })).not.toBe(agent);
  });
});

describe('a pinned agent and kept-alive sockets', () => {
  const servers: Server[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      })
    );
  });

  async function listen() {
    const key = newKeyPair();
    const cert = makeCertificate({ subjectCn: 'fm.internal', altNames: ['fm.internal'], notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: key });
    let connections = 0;
    const server = createServer({ key: keyToPem(key), cert: cert.pem }, (_request, response) => {
      response.end('ok');
    });
    server.on('secureConnection', () => (connections += 1));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, pin: normalizeSha256(cert.fingerprint256) as string, connections: () => connections };
  }

  const fetchOnce = (port: number, agent: PinnedCertificateAgent): Promise<string> =>
    new Promise((resolve) => {
      get({ host: '127.0.0.1', port, path: '/', agent }, (response) => {
        response.resume();
        response.on('end', () => resolve('OK'));
      }).on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    });

  it('the agent the extension builds does not keep sockets alive: every request is a new, checked connection', async () => {
    const server = await listen();
    const agent = createHttpsAgentForProfile({ pinnedCertSha256: server.pin });
    expect(agent).toBeInstanceOf(PinnedCertificateAgent);
    expect((agent.options as { keepAlive?: boolean }).keepAlive).toBeFalsy();
    for (let i = 0; i < 4; i += 1) {
      expect(await fetchOnce(server.port, agent as PinnedCertificateAgent)).toBe('OK');
    }
    expect(server.connections()).toBe(4);
  });

  it('does not change the request options it is given (Node files a kept-alive socket under a name built from them, so changing them stranded the socket)', () => {
    const agent = new PinnedCertificateAgent({ keepAlive: true }, { sha256: 'ab'.repeat(32), allowExpired: false });
    const options = { host: '127.0.0.1', port: 1, servername: '127.0.0.1' };
    const before = JSON.stringify(options);
    const socket = agent.createConnection(options);
    socket.on('error', () => undefined);
    socket.destroy();
    expect(JSON.stringify(options)).toBe(before);
    expect(Object.keys(options)).toEqual(['host', 'port', 'servername']);
    agent.destroy();
  });
});
