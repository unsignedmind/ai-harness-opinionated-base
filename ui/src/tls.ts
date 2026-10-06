// HTTPS for `npm run dev-to-lan`: a self-signed certificate created once and kept in
// <specs>/.chat/tls (never committed), so a phone accepts it once and messages and cookies are not
// readable on the Wi-Fi. A new one is made only when this machine gets an address it does not cover.
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';

export type Tls = { key: string; cert: string; fingerprint: string };

export function addresses(nets = networkInterfaces()): string[] {
  return Object.values(nets)
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n!.address);
}

// short SHA-256 fingerprint (first 8 bytes), to compare with what the phone shows
export const fingerprintOf = (cert: string) =>
  new X509Certificate(cert).fingerprint256.split(':').slice(0, 8).join(':');

export async function loadTls(stateDir: string, ips = addresses(), host = hostname()): Promise<Tls> {
  const dir = join(stateDir, 'tls');
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  if (existsSync(keyFile) && existsSync(certFile)) {
    const cert = readFileSync(certFile, 'utf8');
    const x = new X509Certificate(cert);
    const covered = ips.every((ip) => x.checkIP(ip) === ip);
    const valid = new Date(x.validTo).getTime() > Date.now() + 7 * 24 * 3600 * 1000;
    if (covered && valid)
      return {
        key: readFileSync(keyFile, 'utf8'),
        cert,
        fingerprint: fingerprintOf(cert),
      };
  }
  const { generate } = await import('selfsigned');
  const now = new Date();
  const pems = await generate([{ name: 'commonName', value: `nos spec-ui (${host})` }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: now,
    notAfterDate: new Date(now.getTime() + 2 * 365 * 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 2, value: host },
          { type: 7, ip: '127.0.0.1' },
          ...ips.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(stateDir, '.gitignore'))) writeFileSync(join(stateDir, '.gitignore'), '*\n');
  writeFileSync(keyFile, pems.private, { mode: 0o600 });
  writeFileSync(certFile, pems.cert);
  return {
    key: pems.private,
    cert: pems.cert,
    fingerprint: fingerprintOf(pems.cert),
  };
}
