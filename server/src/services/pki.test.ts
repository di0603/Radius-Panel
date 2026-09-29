import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EC_P384_SIGNING_ALGORITHM, crlToPem, generateEcKeyPair, sha256Hex, x509 } from '../lib/x509.js';
import { buildCrl, validateIntermediateImport } from './pki.js';

function hasCli(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const DAY = 24 * 60 * 60 * 1000;

interface TestCa {
  keys: CryptoKeyPair;
  cert: x509.X509Certificate;
}

async function makeRootCa(): Promise<TestCa> {
  const keys = await generateEcKeyPair('P-384');
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root CA',
    keys,
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
  return { keys, cert };
}

async function signIntermediate(
  root: TestCa,
  overrides: {
    notBefore?: Date;
    notAfter?: Date;
    basicConstraintsCa?: boolean;
    pathLength?: number;
    keyUsage?: number;
    eku?: (typeof x509.ExtendedKeyUsage)[keyof typeof x509.ExtendedKeyUsage][] | null;
    curve?: 'P-256' | 'P-384';
    rsa?: boolean;
  } = {},
): Promise<TestCa & { spkiSha256: string }> {
  const keys = overrides.rsa
    ? ((await webcrypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair)
    : await generateEcKeyPair(overrides.curve ?? 'P-384');
  const extensions = [
    new x509.BasicConstraintsExtension(
      overrides.basicConstraintsCa ?? true,
      overrides.pathLength ?? 0,
      true,
    ),
    new x509.KeyUsagesExtension(
      overrides.keyUsage ?? x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
      true,
    ),
  ];
  if (overrides.eku !== null) {
    extensions.push(
      new x509.ExtendedKeyUsageExtension(overrides.eku ?? [x509.ExtendedKeyUsage.clientAuth], true),
    );
  }
  const cert = await x509.X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate CA',
    issuer: root.cert.subject,
    publicKey: keys.publicKey,
    signingKey: root.keys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: overrides.notBefore ?? new Date(Date.now() - DAY),
    notAfter: overrides.notAfter ?? new Date(Date.now() + 365 * DAY),
    extensions,
  });
  return { keys, cert, spkiSha256: sha256Hex(cert.publicKey.rawData) };
}

const root = await makeRootCa();
const otherRoot = await makeRootCa();
const goodIntermediate = await signIntermediate(root);

test('validateIntermediateImport: acepta una intermedia ECDSA P-384 correctamente firmada', async () => {
  await assert.doesNotReject(
    validateIntermediateImport({
      intermediateCert: goodIntermediate.cert,
      rootCert: root.cert,
      expectedSpkiSha256: goodIntermediate.spkiSha256,
    }),
  );
});

test('validateIntermediateImport: rechaza si la huella de clave no coincide', async () => {
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: goodIntermediate.cert,
      rootCert: root.cert,
      expectedSpkiSha256: 'f'.repeat(64),
    }),
    /no corresponde a la clave privada/,
  );
});

test('validateIntermediateImport: rechaza si no la firmo la raiz indicada', async () => {
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: goodIntermediate.cert,
      rootCert: otherRoot.cert,
      expectedSpkiSha256: goodIntermediate.spkiSha256,
    }),
    /no esta firmado por la CA raiz/,
  );
});

test('validateIntermediateImport: rechaza sin BasicConstraints CA:true', async () => {
  const bad = await signIntermediate(root, { basicConstraintsCa: false });
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: bad.cert,
      rootCert: root.cert,
      expectedSpkiSha256: bad.spkiSha256,
    }),
    /no es un certificado de CA/,
  );
});

test('validateIntermediateImport: rechaza BasicConstraints sin pathLenConstraint = 0', async () => {
  const bad = await signIntermediate(root, { pathLength: 1 });
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: bad.cert,
      rootCert: root.cert,
      expectedSpkiSha256: bad.spkiSha256,
    }),
    /pathLenConstraint/,
  );
});

test('validateIntermediateImport: rechaza sin KeyUsage keyCertSign/cRLSign', async () => {
  const bad = await signIntermediate(root, { keyUsage: x509.KeyUsageFlags.digitalSignature });
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: bad.cert,
      rootCert: root.cert,
      expectedSpkiSha256: bad.spkiSha256,
    }),
    /KeyUsage/,
  );
});

test('validateIntermediateImport: rechaza sin ExtendedKeyUsage', async () => {
  const bad = await signIntermediate(root, { eku: null });
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: bad.cert,
      rootCert: root.cert,
      expectedSpkiSha256: bad.spkiSha256,
    }),
    /no tiene ExtendedKeyUsage/,
  );
});

test('validateIntermediateImport: rechaza EKU con un uso distinto de clientAuth', async () => {
  const bad = await signIntermediate(root, {
    eku: [x509.ExtendedKeyUsage.clientAuth, x509.ExtendedKeyUsage.serverAuth],
  });
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: bad.cert,
      rootCert: root.cert,
      expectedSpkiSha256: bad.spkiSha256,
    }),
    /unicamente clientAuth/,
  );
});

test('validateIntermediateImport: rechaza una clave ECDSA P-256 (exige P-384)', async () => {
  const bad = await signIntermediate(root, { curve: 'P-256' });
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: bad.cert,
      rootCert: root.cert,
      expectedSpkiSha256: bad.spkiSha256,
    }),
    /ECDSA P-384/,
  );
});

test('validateIntermediateImport: rechaza una clave RSA (exige ECDSA P-384)', async () => {
  const bad = await signIntermediate(root, { rsa: true });
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: bad.cert,
      rootCert: root.cert,
      expectedSpkiSha256: bad.spkiSha256,
    }),
    /ECDSA P-384/,
  );
});

test('validateIntermediateImport: rechaza un certificado caducado', async () => {
  const bad = await signIntermediate(root, {
    notBefore: new Date(Date.now() - 60 * DAY),
    notAfter: new Date(Date.now() - 30 * DAY),
  });
  await assert.rejects(
    validateIntermediateImport({
      intermediateCert: bad.cert,
      rootCert: root.cert,
      expectedSpkiSha256: bad.spkiSha256,
    }),
    /no esta vigente/,
  );
});

test('buildCrl: firma una CRL vacia valida, con nextUpdate a 7 dias', async () => {
  const crl = await buildCrl({
    issuerCert: goodIntermediate.cert,
    signingKey: goodIntermediate.keys.privateKey,
    entries: [],
  });
  assert.equal(crl.entries.length, 0);
  assert.equal(await crl.verify({ publicKey: goodIntermediate.cert.publicKey }), true);
  const days = Math.round((crl.nextUpdate!.getTime() - crl.thisUpdate.getTime()) / DAY);
  assert.equal(days, 7);
});

test('buildCrl: incluye los certificados revocados y firma correctamente', async () => {
  const revocationDate = new Date();
  const crl = await buildCrl({
    issuerCert: goodIntermediate.cert,
    signingKey: goodIntermediate.keys.privateKey,
    entries: [
      { serialNumber: '0102030405', revocationDate, reason: x509.X509CrlReason.keyCompromise },
    ],
  });
  assert.equal(crl.entries.length, 1);
  assert.equal(crl.entries[0]!.serialNumber.toLowerCase(), '0102030405');
  assert.equal(crl.entries[0]!.reason, x509.X509CrlReason.keyCompromise);
  assert.equal(await crl.verify({ publicKey: goodIntermediate.cert.publicKey }), true);
});

test('buildCrl: no verifica contra una clave publica que no la firmo', async () => {
  const crl = await buildCrl({
    issuerCert: goodIntermediate.cert,
    signingKey: goodIntermediate.keys.privateKey,
    entries: [],
  });
  assert.equal(await crl.verify({ publicKey: otherRoot.cert.publicKey }), false);
});

test('crlToPem: etiqueta "-----BEGIN X509 CRL-----" (RFC 7468), no "-----BEGIN CRL-----" de @peculiar/x509', async () => {
  const crl = await buildCrl({
    issuerCert: goodIntermediate.cert,
    signingKey: goodIntermediate.keys.privateKey,
    entries: [],
  });
  const pem = crlToPem(crl);
  assert.match(pem, /-----BEGIN X509 CRL-----/);
  assert.match(pem, /-----END X509 CRL-----/);
  assert.doesNotMatch(pem, /-----BEGIN CRL-----/); // la etiqueta de la libreria, sin "X509 "
});

test(
  'crlToPem: "openssl crl -in ... -noout" la lee SIN ninguna conversion (nunca hace falta el sed de tolerancia del script de sincronizacion)',
  { skip: !hasCli('openssl') && 'openssl no disponible' },
  async () => {
    const crl = await buildCrl({
      issuerCert: goodIntermediate.cert,
      signingKey: goodIntermediate.keys.privateKey,
      entries: [],
    });
    const pem = crlToPem(crl);
    const dir = mkdtempSync(join(tmpdir(), 'crl-pem-label-'));
    const crlPath = join(dir, 'crl.pem');
    writeFileSync(crlPath, pem, 'utf8');

    // No conversion de ningun tipo (ni sed, ni -inform distinto): si la
    // etiqueta fuera la vieja ("CRL" sin "X509 "), este comando fallaria con
    // "unsupported"/"No supported data to decode" (lo que motivo este fix).
    const output = execFileSync('openssl', ['crl', '-in', crlPath, '-noout', '-text'], { encoding: 'utf8' });
    assert.match(output, /Certificate Revocation List/);
  },
);
