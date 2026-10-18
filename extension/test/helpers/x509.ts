import { createHash, generateKeyPairSync, sign, type KeyObject } from 'crypto';

/**
 * A small X.509 certificate writer for tests, so a test can make a certificate that is expired,
 * not yet valid, for another host, issued by a private CA, and so on, on any machine without the
 * openssl command (whose options for back-dated certificates differ between versions).
 * ECDSA P-256 with SHA-256 only. Never used outside tests.
 */

function len(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...c: Buffer[]) => tlv(0x30, ...c);
const set = (...c: Buffer[]) => tlv(0x31, ...c);
const oid = (dotted: string): Buffer => {
  const parts = dotted.split('.').map(Number);
  const first = parts[0] as number;
  const second = parts[1] as number;
  const out: number[] = [first * 40 + second];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let n = part >> 7; n > 0; n >>= 7) chunk.unshift((n & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const integer = (value: number): Buffer => {
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  if (bytes.length === 0 || (bytes[0] as number) & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
};
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const octets = (data: Buffer) => tlv(0x04, data);
const bits = (data: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), data]));
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const time = (date: Date) => {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
};
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const extension = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export const newKeyPair = (): KeyPair => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

export interface CertificateSpec {
  subjectCn: string;
  /** Names the certificate is valid for (DNS names; `IP:1.2.3.4` for addresses). */
  altNames?: string[];
  notBefore: Date;
  notAfter: Date;
  subjectKey: KeyPair;
  /** The signer; omit for a self-signed certificate. */
  issuer?: { cn: string; key: KeyPair };
  isCa?: boolean;
  serial?: number;
}

export interface Certificate {
  pem: string;
  der: Buffer;
  /** SHA-256 fingerprint as Node reports it: upper-case hex pairs separated by colons. */
  fingerprint256: string;
}

export function makeCertificate(spec: CertificateSpec): Certificate {
  const issuerCn = spec.issuer?.cn ?? spec.subjectCn;
  const signer = spec.issuer?.key ?? spec.subjectKey;
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'));
  const extensions: Buffer[] = [];
  if (spec.isCa) {
    extensions.push(extension('2.5.29.19', true, seq(bool(true))));
  } else {
    extensions.push(extension('2.5.29.19', true, seq()));
  }
  if (spec.altNames?.length) {
    const entries = spec.altNames.map((entry) =>
      entry.startsWith('IP:')
        ? tlv(0x87, Buffer.from(entry.slice(3).split('.').map(Number)))
        : tlv(0x82, Buffer.from(entry, 'ascii'))
    );
    extensions.push(extension('2.5.29.17', false, seq(...entries)));
  }

  const tbs = seq(
    tlv(0xa0, integer(2)),
    integer(spec.serial ?? Math.floor(Math.random() * 1_000_000) + 1),
    sigAlg,
    name(issuerCn),
    seq(time(spec.notBefore), time(spec.notAfter)),
    name(spec.subjectCn),
    spec.subjectKey.publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...extensions))
  );
  const signature = sign('sha256', tbs, signer.privateKey);
  const der = seq(tbs, sigAlg, bits(signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
  const fingerprint256 = createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .replace(/(..)(?=.)/g, '$1:');
  return { pem, der, fingerprint256 };
}

export const keyToPem = (pair: KeyPair): string =>
  pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export const DAY = 24 * 60 * 60 * 1000;
