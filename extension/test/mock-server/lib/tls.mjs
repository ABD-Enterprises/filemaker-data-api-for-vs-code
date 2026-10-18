// Certificate material for the mock's TLS modes, generated with the system `openssl` (LibreSSL or OpenSSL).
//   self-signed           one self-signed server certificate (the client must "allow self-signed")
//   ca                    a throwaway CA plus a server certificate it signed (the client trusts caPath)
//   expired               leaf signed by the CA but already expired (trust caPath to see the expiry error)
//   notyet                leaf signed by the CA, valid only from the future
//   wronghost             leaf signed by the CA, but only for other.example.test (hostname mismatch)
//   missing-intermediate  root -> intermediate -> leaf, the server sends the leaf only (caPath = root,
//                         intermediatePath = the intermediate)
//   tls10-only            leaf signed by the CA, server limited to TLS 1.0/1.1
//   claris-default-cert   FileMaker Server's default certificate shape: a CN-only leaf ("Claris Self Signed Certificate
//                         (Not for Production Use)", no subjectAltName), issued by "Claris Root Authority", the server sends the
//                         leaf only; caPath is the root PEM
// Dates use `openssl ca -startdate/-enddate`, so OpenSSL 3.4's -not_before is not needed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TLS_MODES = [
  'claris-default-cert',
  'self-signed',
  'ca',
  'expired',
  'notyet',
  'wronghost',
  'missing-intermediate',
  'tls10-only'
];

const fmt = (d) =>
  `${d.getUTCFullYear() % 100}`.padStart(2, '0') +
  `${d.getUTCMonth() + 1}`.padStart(2, '0') +
  `${d.getUTCDate()}`.padStart(2, '0') +
  '000000Z';
const daysFromNow = (n) => fmt(new Date(Date.now() + n * 86400000));

export function makeCerts(mode, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-mock-tls-'))) {
  const run = (...args) =>
    execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
  try {
    run('version');
  } catch {
    throw new Error('TLS modes need the openssl command on PATH.');
  }
  if (!TLS_MODES.includes(mode)) throw new Error(`unknown TLS mode ${mode}`);
  const out = {
    dir,
    key: path.join(dir, 'server.key'),
    cert: path.join(dir, 'server.pem'),
    caPath: undefined,
    intermediatePath: undefined,
    tlsVersions: undefined,
    mode
  };
  const sanFile = (name, san) => {
    const f = path.join(dir, `${name}.cnf`);
    fs.writeFileSync(
      f,
      `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=${san}\nbasicConstraints=CA:FALSE\n`
    );
    return f;
  };

  if (mode === 'self-signed') {
    const cnf = sanFile('san', 'DNS:localhost,IP:127.0.0.1');
    run(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      out.key,
      '-out',
      out.cert,
      '-days',
      '2',
      '-config',
      cnf,
      '-extensions',
      'v3'
    );
    return out;
  }

  // A tiny `openssl ca` database per authority.
  const makeAuthority = (name, parent, dnLines) => {
    const adir = path.join(dir, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    fs.mkdirSync(path.join(adir, 'newcerts'), { recursive: true });
    fs.writeFileSync(path.join(adir, 'index.txt'), '');
    fs.writeFileSync(path.join(adir, 'serial'), '1000\n');
    const key = path.join(adir, 'key.pem');
    const cert = path.join(adir, 'cert.pem');
    const conf = path.join(adir, 'ca.cnf');
    fs.writeFileSync(
      conf,
      `[ca]\ndefault_ca=CA\n[CA]\ndir=${adir}\ndatabase=${adir}/index.txt\nnew_certs_dir=${adir}/newcerts\nserial=${adir}/serial\nprivate_key=${key}\ncertificate=${cert}\ndefault_md=sha256\npolicy=pol\nunique_subject=no\ncopy_extensions=none\n[pol]\ncommonName=supplied\n[req]\ndistinguished_name=dn\nprompt=no\n[dn]\n${dnLines ?? `CN=${name}`}\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`
    );
    if (!parent) {
      run(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '3',
        '-config',
        conf,
        '-extensions',
        'v3_ca'
      );
    } else {
      const csr = path.join(adir, 'ca.csr');
      run(
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        csr,
        '-config',
        conf
      );
      run(
        'ca',
        '-batch',
        '-config',
        parent.conf,
        '-in',
        csr,
        '-out',
        cert,
        '-days',
        '3',
        '-extensions',
        'v3_ca',
        '-notext'
      );
    }
    return { dir: adir, key, cert, conf };
  };
  const issue = (authority, { san, start, end, cn = 'localhost' }) => {
    const extra = san ? `subjectAltName=${san}\n` : '';
    const csr = path.join(dir, 'leaf.csr');
    run(
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      out.key,
      '-out',
      csr,
      '-subj',
      `/CN=${cn}`
    );
    const ext = path.join(dir, 'leaf-ext.cnf');
    fs.writeFileSync(ext, `[leaf]\nsubjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
    // openssl ca reads extensions from the CA config: append a section there.
    fs.appendFileSync(authority.conf, `[leaf]\n${extra}basicConstraints=CA:FALSE\n`);
    const args = [
      'ca',
      '-batch',
      '-config',
      authority.conf,
      '-in',
      csr,
      '-out',
      out.cert,
      '-extensions',
      'leaf',
      '-notext'
    ];
    if (start && end) args.push('-startdate', start, '-enddate', end);
    else args.push('-days', mode === 'claris-default-cert' ? '365' : '2');
    run(...args);
  };

  const root =
    mode === 'claris-default-cert'
      ? makeAuthority(
          'Claris Root Authority',
          undefined,
          'CN=Claris Root Authority\nOU=Claris International Inc.\nemailAddress=security@claris.com'
        )
      : makeAuthority('Mock Root CA');
  out.caPath = root.cert;
  const local = 'DNS:localhost,IP:127.0.0.1';
  if (mode === 'claris-default-cert')
    issue(root, { san: undefined, cn: 'Claris Self Signed Certificate (Not for Production Use)' });
  else if (mode === 'ca' || mode === 'tls10-only') {
    issue(root, { san: local });
    if (mode === 'tls10-only')
      out.tlsVersions = { minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'ALL:@SECLEVEL=0' };
  } else if (mode === 'expired')
    issue(root, { san: local, start: daysFromNow(-30), end: daysFromNow(-2) });
  else if (mode === 'notyet')
    issue(root, { san: local, start: daysFromNow(10), end: daysFromNow(40) });
  else if (mode === 'wronghost') issue(root, { san: 'DNS:other.example.test' });
  else if (mode === 'missing-intermediate') {
    const inter = makeAuthority('Mock Intermediate CA', root);
    out.intermediatePath = inter.cert;
    issue(inter, { san: local });
  }
  return out;
}
