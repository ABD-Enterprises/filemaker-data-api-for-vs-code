// Certificate material for the mock's TLS modes, generated with the system `openssl` (LibreSSL or OpenSSL).
//   self-signed           one self-signed server certificate (the client must "allow self-signed")
//   ca                    a throwaway CA plus a server certificate it signed (the client trusts caPath)
//   expired               leaf signed by the CA but already expired (trust caPath to see the expiry error)
//   notyet                leaf signed by the CA, valid only from the future
//   wronghost             leaf signed by the CA, but only for other.example.test (hostname mismatch)
//   missing-intermediate  root -> intermediate -> leaf, the server sends the leaf only (caPath = root,
//                         intermediatePath = the intermediate)
//   tls10-only            leaf signed by the CA, server limited to TLS 1.0/1.1
//   claris-default-cert   FileMaker Server 22's default certificate, as read from a real server: an X.509 version 1 leaf
//                         (serial 1, sha256WithRSA, 2048-bit, NO extensions at all: no subjectAltName, no basicConstraints)
//                         whose subject is "C=US, ST=California, L=Santa Clara, O=Claris International Inc., CN=Claris Self
//                         Signed Certificate (Not for Production Use)", issued by "C=US, OU=Claris International Inc.,
//                         OU=Copyright (c) 2026 Claris International Inc., O=Claris International Inc., CN=Claris Root
//                         Authority, emailAddress=security@claris.com". The server sends the leaf only and speaks TLS 1.2
//                         only. caPath is the root PEM (the real root is not on the server, so a client cannot build the chain).
// Dates use `openssl ca -startdate/-enddate`, so OpenSSL 3.4's -not_before is not needed.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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

// ---- A minimal DER encoder, enough for one certificate (see the claris-default-cert mode) ----
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len =
    n < 128
      ? Buffer.from([n])
      : n < 256
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = (dotted) => {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const value of parts.slice(2)) {
    const group = [value & 0x7f];
    for (let rest = value >> 7; rest > 0; rest >>= 7) group.unshift((rest & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const text = (tag, value) => tlv(tag, Buffer.from(value, 'utf8'));
const rdn = (id, tag, value) => set(seq(oid(id), text(tag, value)));
const utcTime = (date) => {
  const two = (n) => String(n).padStart(2, '0');
  return text(
    0x17,
    `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`
  );
};

/** The issuer field of a PEM certificate, as the exact bytes (so a certificate issued by it names it identically). */
function issuerBytesOf(pemPath) {
  const der = Buffer.from(
    fs.readFileSync(pemPath, 'utf8').replace(/-----[A-Z ]+-----|\s/g, ''),
    'base64'
  );
  const read = (offset) => {
    let length = der[offset + 1];
    let header = 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      length = 0;
      for (let i = 0; i < count; i += 1) length = (length << 8) | der[offset + 2 + i];
      header = 2 + count;
    }
    return { tag: der[offset], start: offset, header, end: offset + header + length };
  };
  const cert = read(0);
  const tbs = read(cert.start + cert.header);
  let element = read(tbs.start + tbs.header);
  if (element.tag === 0xa0) element = read(element.end); // the version, absent in a version 1 certificate
  element = read(element.end); // the serial number was the one before; this is the signature algorithm
  element = read(element.end); // and this is the issuer
  return der.subarray(element.start, element.end);
}

/**
 * FileMaker Server 22's default leaf certificate as read from a real server: X.509 version 1 (no version field), serial 1,
 * sha256WithRSAEncryption, 2048-bit RSA, no extensions, signed by the Claris root made for this mock.
 */
function writeClarisLeaf(keyPath, certPath, rootKeyPath, rootCertPath) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const sha256WithRsa = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05));
  const subject = seq(
    rdn('2.5.4.6', 0x13, 'US'),
    rdn('2.5.4.8', 0x0c, 'California'),
    rdn('2.5.4.7', 0x0c, 'Santa Clara'),
    rdn('2.5.4.10', 0x0c, 'Claris International Inc.'),
    rdn('2.5.4.3', 0x0c, 'Claris Self Signed Certificate (Not for Production Use)')
  );
  const now = Date.now();
  const tbs = seq(
    tlv(0x02, Buffer.from([1])),
    sha256WithRsa,
    issuerBytesOf(rootCertPath),
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 365 * 86400000))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' })
  );
  const signature = crypto.sign(
    'sha256',
    tbs,
    crypto.createPrivateKey(fs.readFileSync(rootKeyPath, 'utf8'))
  );
  const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = der
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  fs.writeFileSync(certPath, `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`);
}

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

  if (mode === 'claris-default-cert') {
    // The leaf is encoded here, not by `openssl`: a version 1 certificate with no extensions, like the real one, cannot be
    // had from every OpenSSL build (3.x and later add key identifiers and mark the certificate version 3).
    const rootKey = path.join(dir, 'claris-root.key');
    const rootCert = path.join(dir, 'claris-root.pem');
    const rootCnf = path.join(dir, 'claris-root.cnf');
    fs.writeFileSync(
      rootCnf,
      '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nC=US\n0.OU=Claris International Inc.\n1.OU=Copyright (c) 2026 Claris International Inc.\nO=Claris International Inc.\nCN=Claris Root Authority\nemailAddress=security@claris.com\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n'
    );
    run(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      rootKey,
      '-out',
      rootCert,
      '-days',
      '400',
      '-config',
      rootCnf
    );
    writeClarisLeaf(out.key, out.cert, rootKey, rootCert);
    out.caPath = rootCert;
    out.tlsVersions = { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' };
    return out;
  }

  // A tiny `openssl ca` database per authority.
  const makeAuthority = (name, parent, dnLines) => {
    const adir = path.join(dir, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    fs.mkdirSync(path.join(adir, 'newcerts'), { recursive: true });
    fs.writeFileSync(path.join(adir, 'index.txt'), '');
    fs.writeFileSync(path.join(adir, 'serial'), '1000\n');
    // openssl config files treat a backslash as an escape, so Windows paths go in with forward slashes.
    const slash = (p) => p.replace(/\\/g, '/');
    const key = path.join(adir, 'key.pem');
    const cert = path.join(adir, 'cert.pem');
    const conf = path.join(adir, 'ca.cnf');
    fs.writeFileSync(
      conf,
      `[ca]\ndefault_ca=CA\n[CA]\ndir=${slash(adir)}\ndatabase=${slash(adir)}/index.txt\nnew_certs_dir=${slash(adir)}/newcerts\nserial=${slash(adir)}/serial\nprivate_key=${slash(key)}\ncertificate=${slash(cert)}\ndefault_md=sha256\npolicy=pol\nunique_subject=no\ncopy_extensions=none\n[pol]\ncommonName=supplied\n[req]\ndistinguished_name=dn\nprompt=no\n[dn]\n${dnLines ?? `CN=${name}`}\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`
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
    else args.push('-days', '2');
    run(...args);
  };

  const root = makeAuthority('Mock Root CA');
  out.caPath = root.cert;
  const local = 'DNS:localhost,IP:127.0.0.1';
  if (mode === 'ca' || mode === 'tls10-only') {
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
