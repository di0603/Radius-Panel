import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import QRCode from 'qrcode';
import * as pools from '../db/pools.js';
import { config } from '../config.js';
import { PROFILE_SIGNING_KEY_ID } from '../lib/vpnProfileSigning.js';
import { EC_P384_SIGNING_ALGORITHM, generateEcKeyPair, sha256Hex, x509 } from '../lib/x509.js';
import {
  ESP_PROPOSAL,
  IKE_PROPOSAL,
  PROFILE_SCHEMA_VERSION,
  buildProvisioningProfilePayload,
  buildProvisioningQrDataUrl,
  buildSignedProvisioningProfiles,
} from './vpnProvisioning.js';

/**
 * `buildProvisioningProfilePayload`/`buildSignedProvisioningProfiles` llaman
 * a `getVpnSettings()`/`getCaChainPem()`/`getRootCaCert()`, que a su vez
 * consultan `panelPool`: se mockea ahi (mismo patron que el resto de tests
 * del proyecto), no las funciones de servicio directamente. `getRootCaCert`
 * parsea el PEM de verdad (`new x509.X509Certificate(...)`), asi que hace
 * falta una cadena real -no un blob base64 cualquiera-: se genera una raiz +
 * intermedia ECDSA P-384 con nombres como los reales, igual que en
 * deviceCerts.test.ts.
 */

const DAY = 24 * 60 * 60 * 1000;

async function makeRealChain() {
  const rootKeys = await generateEcKeyPair('P-384');
  const rootCert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=didev Root CA',
    keys: rootKeys,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 3650 * DAY),
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  const intermediateKeys = await generateEcKeyPair('P-384');
  const intermediateCert = await x509.X509CertificateGenerator.create({
    subject: 'CN=didev VPN Intermedia 2026',
    issuer: rootCert.subject,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 1825 * DAY),
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
    ],
  });

  return {
    rootCert,
    intermediateCert,
    rootCaSha256: sha256Hex(rootCert.rawData),
  };
}

function mockSettingsAndCa(
  chain: { rootCert: x509.X509Certificate; intermediateCert: x509.X509Certificate },
  settingsOverrides: Record<string, unknown> = {},
): void {
  mock.method(pools.panelPool, 'query', ((sql: string) => {
    if (sql.includes('FROM panel_vpn_settings')) {
      return [
        [
          {
            vpn_fqdn: 'vpn.example.com',
            aaa_id: 'CN=radius.example.com',
            pool_start: '192.168.10.75',
            pool_end: '192.168.10.99',
            lan_cidr: '192.168.10.0/24',
            dns: '1.1.1.1',
            device_cert_days: 30,
            renew_after_days: 20,
            overlap_hours: 48,
            android_cert_days: 365,
            est_url: 'https://est.example.com:8443',
            min_app_version: '1.0.0',
            ...settingsOverrides,
          },
        ],
        [],
      ];
    }
    // getCaChainPem y getRootCaCert filtran las dos por el mismo status set;
    // una unica fila con cert_pem + root_cert_pem sirve para ambas.
    if (sql.includes('FROM panel_pki_ca WHERE status IN')) {
      return [
        [{ cert_pem: chain.intermediateCert.toString(), root_cert_pem: chain.rootCert.toString() }],
        [],
      ];
    }
    throw new Error(`panelPool.query no esperado en el test: ${sql}`);
  }) as never);
}

function writeTempKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'radius-panel-profile-key-'));
  const keyPath = join(dir, 'key.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  return { keyPath, publicKey };
}

test('buildProvisioningProfilePayload: variante "full" lleva la cadena de CA completa y rootCaSha256', async () => {
  const chain = await makeRealChain();
  mockSettingsAndCa(chain);
  try {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2026-01-02T00:00:00.000Z');
    const payload = await buildProvisioningProfilePayload({
      device: { username: 'vpn-juan-laptop', tunnelMode: 'full' },
      token: 'el-token-secreto',
      issuedAt,
      expiresAt,
      variant: 'full',
    });
    assert.deepEqual(payload, {
      version: PROFILE_SCHEMA_VERSION,
      variant: 'full',
      cn: 'vpn-juan-laptop',
      server: 'vpn.example.com',
      aaaId: 'CN=radius.example.com',
      rootCaSha256: chain.rootCaSha256,
      caChainPem: `${chain.intermediateCert.toString()}\n${chain.rootCert.toString()}`,
      ike: IKE_PROPOSAL,
      esp: ESP_PROPOSAL,
      tunnelMode: 'full',
      splitRoutes: [],
      dns: '1.1.1.1',
      estBaseUrl: 'https://est.example.com:8443/.well-known/est',
      enrollToken: 'el-token-secreto',
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  } finally {
    mock.restoreAll();
  }
});

test('buildProvisioningProfilePayload: variante "qr" NO lleva caChainPem, pero si rootCaSha256', async () => {
  const chain = await makeRealChain();
  mockSettingsAndCa(chain);
  try {
    const payload = await buildProvisioningProfilePayload({
      device: { username: 'vpn-juan-laptop', tunnelMode: 'full' },
      token: 't',
      issuedAt: new Date(),
      expiresAt: new Date(),
      variant: 'qr',
    });
    assert.equal(payload.variant, 'qr');
    assert.equal(payload.rootCaSha256, chain.rootCaSha256);
    assert.ok(!('caChainPem' in payload), 'la variante qr no debe llevar caChainPem');
  } finally {
    mock.restoreAll();
  }
});

test('buildProvisioningProfilePayload: modo split incluye lan_cidr como unica ruta', async () => {
  const chain = await makeRealChain();
  mockSettingsAndCa(chain);
  try {
    const payload = await buildProvisioningProfilePayload({
      device: { username: 'vpn-maria-vps', tunnelMode: 'split' },
      token: 't',
      issuedAt: new Date(),
      expiresAt: new Date(),
      variant: 'full',
    });
    assert.deepEqual(payload.splitRoutes, ['192.168.10.0/24']);
  } finally {
    mock.restoreAll();
  }
});

test('buildProvisioningProfilePayload: rechaza si la CA de la VPN todavia no esta configurada', async () => {
  mock.method(pools.panelPool, 'query', ((sql: string) => {
    if (sql.includes('FROM panel_vpn_settings')) {
      const err = new Error('sin tabla') as Error & { code: string };
      err.code = 'ER_NO_SUCH_TABLE';
      throw err;
    }
    if (sql.includes('FROM panel_pki_ca WHERE status IN')) return [[], []];
    throw new Error('panelPool.query no esperado en el test');
  }) as never);
  try {
    await assert.rejects(
      buildProvisioningProfilePayload({
        device: { username: 'vpn-juan-laptop', tunnelMode: 'full' },
        token: 't',
        issuedAt: new Date(),
        expiresAt: new Date(),
        variant: 'full',
      }),
      /CA de la VPN todavia no esta configurada/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('buildSignedProvisioningProfiles: null si VPN_PROFILE_SIGNING_KEY no esta configurada (no bloquea el alta por EST manual)', async () => {
  const chain = await makeRealChain();
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = undefined;
  mockSettingsAndCa(chain);
  try {
    const result = await buildSignedProvisioningProfiles({
      device: { username: 'vpn-juan-laptop', tunnelMode: 'full' },
      token: 't',
      issuedAt: new Date(),
      expiresAt: new Date(),
    });
    assert.equal(result, null);
  } finally {
    mock.restoreAll();
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('buildSignedProvisioningProfiles: full y qr firman por separado, los dos verifican y llevan rootCaSha256; solo full lleva caChainPem', async () => {
  const chain = await makeRealChain();
  const { keyPath, publicKey } = writeTempKey();
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;
  mockSettingsAndCa(chain);
  try {
    const result = await buildSignedProvisioningProfiles({
      device: { username: 'vpn-juan-laptop', tunnelMode: 'full' },
      token: 'el-token-secreto',
      issuedAt: new Date(),
      expiresAt: new Date(),
    });
    assert.ok(result);
    assert.equal(result!.filename, 'vpn-juan-laptop.didevvpn');
    assert.equal(result!.full.keyId, PROFILE_SIGNING_KEY_ID);
    assert.equal(result!.qr.keyId, PROFILE_SIGNING_KEY_ID);

    for (const envelope of [result!.full, result!.qr]) {
      const payloadBytes = Buffer.from(envelope.payload, 'base64url');
      const signatureBytes = Buffer.from(envelope.signature, 'base64url');
      assert.equal(verify(null, payloadBytes, publicKey, signatureBytes), true);
    }

    const fullDecoded = JSON.parse(Buffer.from(result!.full.payload, 'base64url').toString('utf8'));
    const qrDecoded = JSON.parse(Buffer.from(result!.qr.payload, 'base64url').toString('utf8'));

    assert.equal(fullDecoded.variant, 'full');
    assert.equal(fullDecoded.rootCaSha256, chain.rootCaSha256);
    assert.ok('caChainPem' in fullDecoded);

    assert.equal(qrDecoded.variant, 'qr');
    assert.equal(qrDecoded.rootCaSha256, chain.rootCaSha256);
    assert.ok(!('caChainPem' in qrDecoded), 'la variante qr no debe llevar caChainPem');

    // Las dos firmas son independientes: la del sobre completo no vale para
    // el payload del compacto (son bytes distintos), y viceversa.
    assert.equal(
      verify(null, Buffer.from(result!.qr.payload, 'base64url'), publicKey, Buffer.from(result!.full.signature, 'base64url')),
      false,
    );
  } finally {
    mock.restoreAll();
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('buildSignedProvisioningProfiles: el QR compacto (variante "qr") cabe con holgura en una version de QR <= 25', async () => {
  const chain = await makeRealChain();
  const { keyPath } = writeTempKey();
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;
  mockSettingsAndCa(chain);
  try {
    const result = await buildSignedProvisioningProfiles({
      device: { username: 'vpn-juan-laptop-de-sobremesa', tunnelMode: 'split' },
      token: 'el-token-secreto-de-un-solo-uso',
      issuedAt: new Date(),
      expiresAt: new Date(),
    });
    assert.ok(result);

    // El sobre completo (con la cadena de CA) es justo el problema que
    // corrige la variante compacta: con nivel M ni siquiera cabe en ningun
    // QR (con nivel L cabria, pero en una version ~39 practicamente
    // imposible de escanear desde una pantalla) -de ahi que el QR use
    // siempre la variante "qr", nunca la "full"-.
    assert.throws(
      () => QRCode.create(JSON.stringify(result!.full), { errorCorrectionLevel: 'M' }),
      /too big/i,
      'el sobre completo no deberia caber en un QR de nivel M: por eso el QR usa la variante compacta',
    );

    const qrQr = QRCode.create(JSON.stringify(result!.qr), { errorCorrectionLevel: 'M' });
    assert.ok(
      qrQr.version <= 25,
      `el QR compacto deberia caber con holgura en una version <= 25 (salio ${qrQr.version})`,
    );

    const dataUrl = await buildProvisioningQrDataUrl(result!.qr);
    assert.match(dataUrl!, /^data:image\/png;base64,/);
  } finally {
    mock.restoreAll();
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('buildProvisioningQrDataUrl: genera una imagen PNG en data URL', async () => {
  const url = await buildProvisioningQrDataUrl({ payload: 'YWJj', signature: 'ZGVm', keyId: PROFILE_SIGNING_KEY_ID });
  assert.match(url!, /^data:image\/png;base64,/);
});

test('buildProvisioningQrDataUrl: null (no lanza) si el contenido no cabe en un QR legible', async () => {
  const url = await buildProvisioningQrDataUrl({
    payload: 'x'.repeat(20_000),
    signature: 'ZGVm',
    keyId: PROFILE_SIGNING_KEY_ID,
  });
  assert.equal(url, null);
});
