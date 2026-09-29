import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { config } from '../config.js';
import { PROFILE_SIGNING_KEY_ID } from '../lib/vpnProfileSigning.js';
import {
  ESP_PROPOSAL,
  IKE_PROPOSAL,
  PROFILE_SCHEMA_VERSION,
  buildProvisioningProfilePayload,
  buildProvisioningQrDataUrl,
  buildSignedProvisioningProfile,
} from './vpnProvisioning.js';

/**
 * `buildProvisioningProfilePayload`/`buildSignedProvisioningProfile` llaman a
 * `getVpnSettings()`/`getCaChainPem()`, que a su vez consultan `panelPool`:
 * se mockea ahi (mismo patron que el resto de tests del proyecto), no las
 * funciones de servicio directamente.
 */
const FAKE_CA_CHAIN_PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';

function mockSettingsAndCa(settingsOverrides: Record<string, unknown> = {}): void {
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
    if (sql.includes('FROM panel_pki_ca WHERE status IN')) {
      return [[{ cert_pem: FAKE_CA_CHAIN_PEM, root_cert_pem: null }], []];
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

test('buildProvisioningProfilePayload: construye el payload esperado (modo full, sin rutas de split tunnel)', async () => {
  mockSettingsAndCa();
  try {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2026-01-02T00:00:00.000Z');
    const payload = await buildProvisioningProfilePayload({
      device: { username: 'vpn-juan-laptop', tunnelMode: 'full' },
      token: 'el-token-secreto',
      issuedAt,
      expiresAt,
    });
    assert.deepEqual(payload, {
      version: PROFILE_SCHEMA_VERSION,
      cn: 'vpn-juan-laptop',
      server: 'vpn.example.com',
      aaaId: 'CN=radius.example.com',
      caChainPem: FAKE_CA_CHAIN_PEM,
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

test('buildProvisioningProfilePayload: modo split incluye lan_cidr como unica ruta', async () => {
  mockSettingsAndCa();
  try {
    const payload = await buildProvisioningProfilePayload({
      device: { username: 'vpn-maria-vps', tunnelMode: 'split' },
      token: 't',
      issuedAt: new Date(),
      expiresAt: new Date(),
    });
    assert.deepEqual(payload.splitRoutes, ['192.168.10.0/24']);
  } finally {
    mock.restoreAll();
  }
});

test('buildProvisioningProfilePayload: sin dns configurado, el campo es null (no cadena vacia)', async () => {
  mockSettingsAndCa({ dns: '' });
  try {
    const payload = await buildProvisioningProfilePayload({
      device: { username: 'vpn-juan-laptop', tunnelMode: 'full' },
      token: 't',
      issuedAt: new Date(),
      expiresAt: new Date(),
    });
    assert.equal(payload.dns, null);
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
      }),
      /CA de la VPN todavia no esta configurada/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('buildSignedProvisioningProfile: null si VPN_PROFILE_SIGNING_KEY no esta configurada (no bloquea el alta por EST manual)', async () => {
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = undefined;
  mockSettingsAndCa();
  try {
    const result = await buildSignedProvisioningProfile({
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

test('buildSignedProvisioningProfile: firma verificable, y el payload no lleva nada secreto salvo el token de alta', async () => {
  const { keyPath, publicKey } = writeTempKey();
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;
  mockSettingsAndCa();
  try {
    const result = await buildSignedProvisioningProfile({
      device: { username: 'vpn-juan-laptop', tunnelMode: 'full' },
      token: 'el-token-secreto',
      issuedAt: new Date(),
      expiresAt: new Date(),
    });
    assert.ok(result);
    assert.equal(result!.filename, 'vpn-juan-laptop.didevvpn');
    assert.equal(result!.envelope.keyId, PROFILE_SIGNING_KEY_ID);

    const payloadBytes = Buffer.from(result!.envelope.payload, 'base64url');
    const signatureBytes = Buffer.from(result!.envelope.signature, 'base64url');
    assert.equal(verify(null, payloadBytes, publicKey, signatureBytes), true);

    const tampered = Buffer.from(payloadBytes);
    tampered[0] = tampered[0]! ^ 0xff;
    assert.equal(verify(null, tampered, publicKey, signatureBytes), false, 'un byte cambiado debe invalidar la firma');

    // Todo lo que no sea el token de alta ya es publico por si solo (server,
    // cadena de CA -la publica GET /pki/ca-chain.pem-, propuestas, etc.):
    // el unico campo realmente secreto del perfil es enrollToken.
    const decoded = JSON.parse(payloadBytes.toString('utf8'));
    assert.deepEqual(
      Object.keys(decoded).sort(),
      [
        'aaaId',
        'caChainPem',
        'cn',
        'dns',
        'enrollToken',
        'esp',
        'estBaseUrl',
        'expiresAt',
        'ike',
        'issuedAt',
        'server',
        'splitRoutes',
        'tunnelMode',
        'version',
      ],
    );
    assert.equal(decoded.enrollToken, 'el-token-secreto');
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
