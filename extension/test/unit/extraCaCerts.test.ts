import { execFileSync } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { keyToPem } from '../helpers/x509';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';

const canRead = typeof (await import('tls')).getCACertificates === 'function';

/**
 * Node reads NODE_EXTRA_CA_CERTS when the process starts, so this runs the real agent code in a
 * child process started with it. Replacing Node's default list by "bundled roots + system store"
 * would silently drop what the user added that way.
 */
describe.skipIf(!canRead)('NODE_EXTRA_CA_CERTS keeps working with the system-certificate and custom-CA agents', () => {
  it('trusts a server whose CA is only in NODE_EXTRA_CA_CERTS, with the system policy on and with a custom CA file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'extra-ca-'));
    try {
      const now = Date.now();
      const caKey = newKeyPair();
      const ca = makeCertificate({ subjectCn: 'Extra CA', notBefore: new Date(now - DAY), notAfter: new Date(now + DAY), subjectKey: caKey, isCa: true });
      const leafKey = newKeyPair();
      const leaf = makeCertificate({ subjectCn: 'localhost', altNames: ['localhost'], notBefore: new Date(now - DAY), notAfter: new Date(now + DAY), subjectKey: leafKey, issuer: { cn: 'Extra CA', key: caKey } });
      const otherKey = newKeyPair();
      const other = makeCertificate({ subjectCn: 'Other CA', notBefore: new Date(now - DAY), notAfter: new Date(now + DAY), subjectKey: otherKey, isCa: true });

      await writeFile(path.join(dir, 'extra.pem'), ca.pem);
      await writeFile(path.join(dir, 'other.pem'), other.pem);
      await writeFile(path.join(dir, 'leaf.pem'), leaf.pem);
      await writeFile(path.join(dir, 'leaf.key'), keyToPem({ privateKey: leafKey.privateKey, publicKey: leafKey.publicKey }));

      const bundle = path.join(dir, 'tlsAgent.cjs');
      buildSync({
        entryPoints: [path.resolve(__dirname, '../../src/services/tlsAgent.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        external: ['vscode'],
        logLevel: 'error'
      });
      const script = `
        const https = require('https'), fs = require('fs'), path = require('path');
        const { createHttpsAgentForProfile, setSystemCertificatePolicy } = require(${JSON.stringify(bundle)});
        const dir = ${JSON.stringify(dir)};
        const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'leaf.key')), cert: fs.readFileSync(path.join(dir, 'leaf.pem')) }, (q, r) => r.end('ok'));
        server.listen(0, '127.0.0.1', async () => {
          const port = server.address().port;
          const attempt = (profile) => new Promise((resolve) => {
            const agent = createHttpsAgentForProfile(profile);
            https.get({ host: '127.0.0.1', servername: 'localhost', port, agent }, (res) => { res.resume(); resolve('ok'); }).on('error', (e) => resolve(e.code));
          });
          const results = {};
          setSystemCertificatePolicy(() => false);
          results.defaults = await attempt({});
          setSystemCertificatePolicy(() => true);
          results.systemPolicy = await attempt({});
          results.customCa = await attempt({ caBundlePath: path.join(dir, 'other.pem') });
          console.log(JSON.stringify(results));
          process.exit(0);
        });`;
      const run = (extra: string | undefined) =>
        JSON.parse(
          execFileSync(process.execPath, ['-e', script], {
            env: { ...process.env, ...(extra ? { NODE_EXTRA_CA_CERTS: extra } : { NODE_EXTRA_CA_CERTS: '' }) },
            encoding: 'utf8'
          }).trim().split('\n').pop() as string
        ) as Record<string, string>;

      const withExtra = run(path.join(dir, 'extra.pem'));
      expect(withExtra).toEqual({ defaults: 'ok', systemPolicy: 'ok', customCa: 'ok' });

      // Without the variable the same server is not trusted: the successes above come from it.
      const without = run(undefined);
      expect(without.defaults).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
      expect(without.systemPolicy).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
      expect(without.customCa).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
