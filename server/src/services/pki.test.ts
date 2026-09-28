import assert from 'node:assert/strict';
import test from 'node:test';
import { RSA_SIGNING_ALGORITHM, generateRsaKeyPair, sha256Hex, x509 } from '../lib/x509.js';
import { buildCrl, validateIntermediateImport } from './pki.js';

const DAY = 24 * 60 * 60 * 1000;

interface TestCa {
  keys: CryptoKeyPair;
  cert: x509.X509Certificate;
}

async function makeRootCa(): Promise<TestCa> {
  const keys = await generateRsaKeyPair(2048);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root CA',
    keys,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 3650 * DAY),
    signingAlgorithm: RSA_SIGNING_ALGORITHM,
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
    keyUsage?: number;
  } = {},
): Promise<TestCa & { spkiSha256: string }> {
  const keys = await generateRsaKeyPair(2048);
  const cert = await x509.X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate CA',
    issuer: root.cert.subject,
    publicKey: keys.publicKey,
    signingKey: root.keys.privateKey,
    signingAlgorithm: RSA_SIGNING_ALGORITHM,
    notBefore: overrides.notBefore ?? new Date(Date.now() - DAY),
    notAfter: overrides.notAfter ?? new Date(Date.now() + 365 * DAY),
    extensions: [
      new x509.BasicConstraintsExtension(overrides.basicConstraintsCa ?? true, undefined, true),
      new x509.KeyUsagesExtension(
        overrides.keyUsage ?? x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  return { keys, cert, spkiSha256: sha256Hex(cert.publicKey.rawData) };
}

const root = await makeRootCa();
const otherRoot = await makeRootCa();
const goodIntermediate = await signIntermediate(root);

test('validateIntermediateImport: acepta una intermedia correctamente firmada', async () => {
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
