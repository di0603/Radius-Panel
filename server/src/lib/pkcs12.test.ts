import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPkcs12 } from './pkcs12.js';
import { EC_P384_SIGNING_ALGORITHM, exportPrivateKeyPem, generateEcKeyPair, x509 } from './x509.js';

/**
 * `buildPkcs12` es la unica pieza de este proyecto que exporta una clave
 * privada fuera del servidor (para el .p12 de Android). Aqui se comprueba
 * con `openssl pkcs12 -info` de verdad -no solo que "no lanza"- que el
 * fichero generado es un PKCS12 real, importable con la contrasena correcta
 * y solo con ella.
 */

function hasCli(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function makeCert() {
  const rootKeys = await generateEcKeyPair('P-384');
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root',
    keys: rootKeys,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
  });
  const deviceKeys = await generateEcKeyPair('P-256');
  const deviceCert = await x509.X509CertificateGenerator.create({
    subject: 'CN=vpn-test-phone',
    issuer: root.subject,
    publicKey: deviceKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
  });
  return { deviceCert, deviceKeys };
}

test('buildPkcs12: produce un DER que empieza por SEQUENCE (0x30)', async () => {
  const { deviceCert, deviceKeys } = await makeCert();
  const keyPem = await exportPrivateKeyPem(deviceKeys.privateKey);
  const p12 = await buildPkcs12(deviceCert.toString(), keyPem, 'una-contrasena-de-prueba-123');
  assert.equal(p12[0], 0x30);
  assert.ok(p12.length > 0);
});

test(
  'buildPkcs12: openssl abre el .p12 con la contrasena correcta y recupera el CN, y lo rechaza con otra',
  { skip: !hasCli('openssl') && 'openssl no disponible' },
  async () => {
    const { deviceCert, deviceKeys } = await makeCert();
    const keyPem = await exportPrivateKeyPem(deviceKeys.privateKey);
    const password = 'Otra-Contrasena-De-20-Car.';
    const p12 = await buildPkcs12(deviceCert.toString(), keyPem, password);

    const dir = mkdtempSync(join(tmpdir(), 'radius-panel-pkcs12-test-'));
    const p12File = join(dir, 'device.p12');
    writeFileSync(p12File, p12);

    const out = execFileSync(
      'openssl',
      ['pkcs12', '-info', '-in', p12File, '-passin', `pass:${password}`, '-noenc'],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.match(out, /CN=vpn-test-phone/);
    assert.match(out, /BEGIN PRIVATE KEY/);
    assert.match(out, /BEGIN CERTIFICATE/);

    assert.throws(() =>
      execFileSync(
        'openssl',
        ['pkcs12', '-info', '-in', p12File, '-passin', 'pass:contrasena-equivocada', '-noenc'],
        { encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
      ),
    );
  },
);
