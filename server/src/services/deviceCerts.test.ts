import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EC_P384_SIGNING_ALGORITHM, generateEcKeyPair, x509 } from '../lib/x509.js';
import { signDeviceCsr } from './deviceCerts.js';

const DAY = 24 * 60 * 60 * 1000;

async function makeIntermediate() {
  const rootKeys = await generateEcKeyPair('P-384');
  const rootCert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root CA',
    keys: rootKeys,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 3650 * DAY),
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });

  const intermediateKeys = await generateEcKeyPair('P-384');
  const intermediateCert = await x509.X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate CA',
    issuer: rootCert.subject,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
    ],
  });

  return { rootCert, intermediateKeys, intermediateCert };
}

async function makeDeviceCsr(
  cn: string,
  options: { rsaBits?: number; curve?: 'P-256' | 'P-384' } = {},
) {
  const keys = options.rsaBits
    ? ((await webcrypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: options.rsaBits,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair)
    : await generateEcKeyPair(options.curve ?? 'P-256');
  const signingAlgorithm = options.rsaBits
    ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
    : { name: 'ECDSA', hash: 'SHA-256' };
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${cn}`,
    keys,
    signingAlgorithm,
    // BasicConstraints CA:true de "peticion": signDeviceCsr debe ignorarlo.
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { keys, csr };
}

/** Corrompe la firma de un CSR (o cert) sin romper el parseo: cambia el ultimo byte del DER. */
function corruptSignature(pem: string, tag: string): string {
  const der = Buffer.from(x509.PemConverter.decodeFirst(pem));
  der[der.length - 1] ^= 0xff;
  return x509.PemConverter.encode(der, tag);
}

const { rootCert, intermediateKeys, intermediateCert } = await makeIntermediate();

test('signDeviceCsr: emite un certificado con el perfil fijo (ignora lo pedido en el CSR)', async () => {
  const { csr } = await makeDeviceCsr('vpn-juan-laptop');
  const signed = await signDeviceCsr({
    csrPem: csr.toString(),
    cn: 'vpn-juan-laptop',
    days: 30,
    issuerCert: intermediateCert,
    signingKey: intermediateKeys.privateKey,
  });

  const cert = new x509.X509Certificate(signed.certPem);
  assert.equal(await cert.verify({ publicKey: intermediateCert.publicKey }), true);
  assert.equal(signed.serial.length, 32); // 128 bits = 16 bytes = 32 hex chars
  assert.match(signed.serial, /^[0-9a-f]{32}$/);

  const basicConstraints = cert.getExtension(x509.BasicConstraintsExtension);
  assert.equal(basicConstraints?.ca, false); // el CSR pedia CA:true; se ignora

  const keyUsage = cert.getExtension(x509.KeyUsagesExtension);
  assert.equal(keyUsage?.usages, x509.KeyUsageFlags.digitalSignature);

  const eku = cert.getExtension(x509.ExtendedKeyUsageExtension);
  assert.deepEqual(eku ? [...eku.usages] : [], [x509.ExtendedKeyUsage.clientAuth]);

  const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
  assert.equal(san?.names.items.length, 1);
  assert.equal(san?.names.items[0]!.value, 'vpn-juan-laptop');
  // No critica (RFC 5280 4.2.1.6): el subject ya lleva un CN no vacio.
  assert.equal(san?.critical, false);

  assert.ok(cert.getExtension(x509.AuthorityKeyIdentifierExtension));
  assert.ok(cert.getExtension(x509.SubjectKeyIdentifierExtension));

  const expectedNotAfter = signed.notBefore.getTime() + 30 * DAY;
  assert.equal(signed.notAfter.getTime(), expectedNotAfter);
  assert.ok(signed.notBefore.getTime() <= Date.now());
  assert.ok(Date.now() - signed.notBefore.getTime() >= 4 * 60 * 1000); // ~5 min antes
});

test('signDeviceCsr: rechaza si el CN del CSR no coincide con el esperado', async () => {
  const { csr } = await makeDeviceCsr('vpn-juan-laptop');
  await assert.rejects(
    signDeviceCsr({
      csrPem: csr.toString(),
      cn: 'vpn-otro-dispositivo',
      days: 30,
      issuerCert: intermediateCert,
      signingKey: intermediateKeys.privateKey,
    }),
    /no coincide/,
  );
});

test('signDeviceCsr: rechaza un CSR con la firma manipulada', async () => {
  const { csr } = await makeDeviceCsr('vpn-juan-laptop');
  const tampered = corruptSignature(csr.toString(), x509.PemConverter.CertificateRequestTag);
  await assert.rejects(
    signDeviceCsr({
      csrPem: tampered,
      cn: 'vpn-juan-laptop',
      days: 30,
      issuerCert: intermediateCert,
      signingKey: intermediateKeys.privateKey,
    }),
    /firma del CSR no es valida/,
  );
});

test('signDeviceCsr: acepta ECDSA P-256 y P-384', async () => {
  for (const curve of ['P-256', 'P-384'] as const) {
    const { csr } = await makeDeviceCsr('vpn-juan-laptop', { curve });
    await assert.doesNotReject(
      signDeviceCsr({
        csrPem: csr.toString(),
        cn: 'vpn-juan-laptop',
        days: 30,
        issuerCert: intermediateCert,
        signingKey: intermediateKeys.privateKey,
      }),
    );
  }
});

test('signDeviceCsr: acepta RSA >= 3072 pero rechaza RSA mas corto', async () => {
  const good = await makeDeviceCsr('vpn-juan-laptop', { rsaBits: 3072 });
  await assert.doesNotReject(
    signDeviceCsr({
      csrPem: good.csr.toString(),
      cn: 'vpn-juan-laptop',
      days: 30,
      issuerCert: intermediateCert,
      signingKey: intermediateKeys.privateKey,
    }),
  );

  const short = await makeDeviceCsr('vpn-juan-laptop', { rsaBits: 2048 });
  await assert.rejects(
    signDeviceCsr({
      csrPem: short.csr.toString(),
      cn: 'vpn-juan-laptop',
      days: 30,
      issuerCert: intermediateCert,
      signingKey: intermediateKeys.privateKey,
    }),
    /ECDSA P-256\/P-384 o RSA/,
  );
});

/* ------------------------- Verificacion de cadena con openssl ------------------------- */

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test(
  'signDeviceCsr: la cadena raiz -> intermedia -> dispositivo verifica con `openssl verify`',
  { skip: !hasOpenssl() && 'openssl no esta disponible en este entorno' },
  async () => {
    const { csr } = await makeDeviceCsr('vpn-juan-laptop');
    const signed = await signDeviceCsr({
      csrPem: csr.toString(),
      cn: 'vpn-juan-laptop',
      days: 30,
      issuerCert: intermediateCert,
      signingKey: intermediateKeys.privateKey,
    });

    const dir = mkdtempSync(join(tmpdir(), 'radius-panel-pki-test-'));
    const rootPath = join(dir, 'root.pem');
    const intermediatePath = join(dir, 'intermediate.pem');
    const devicePath = join(dir, 'device.pem');
    writeFileSync(rootPath, rootCert.toString());
    writeFileSync(intermediatePath, intermediateCert.toString());
    writeFileSync(devicePath, signed.certPem);

    const output = execFileSync(
      'openssl',
      ['verify', '-CAfile', rootPath, '-untrusted', intermediatePath, devicePath],
      { encoding: 'utf8' },
    );
    assert.match(output, /OK/);
  },
);
