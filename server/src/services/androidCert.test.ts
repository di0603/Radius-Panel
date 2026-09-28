import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { config } from '../config.js';
import { decryptAndroidP12, encryptPkiPrivateKey } from '../lib/pkiCrypto.js';
import { EC_P384_SIGNING_ALGORITHM, exportPrivateKeyPem, generateEcKeyPair, x509 } from '../lib/x509.js';
import { consumeAndroidDownload, issueAndroidCertificate, purgeExpiredAndroidDownloads } from './androidCert.js';

/**
 * "Emitir certificado" es la unica excepcion en todo el modulo VPN donde el
 * panel genera la clave privada de un dispositivo (la app de Android no
 * sabe renovarse sola por EST). Estas pruebas comprueban justo lo que hace
 * segura esa excepcion: el enlace de descarga no sirve dos veces ni
 * caducado, solo funciona desde la LAN/VPN, y el .p12 nunca queda
 * recuperable sin la contrasena de 20 caracteres (mostrada una unica vez) Y
 * la PKI_MASTER_KEY del servidor a la vez.
 */

config.pki.masterKey = 'w'.repeat(32);

const DAY = 24 * 60 * 60 * 1000;

async function makeChain() {
  const rootKeys = await generateEcKeyPair('P-384');
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root',
    keys: rootKeys,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 3650 * DAY),
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
  });
  const interKeys = await generateEcKeyPair('P-384');
  const intermediate = await x509.X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate',
    issuer: root.subject,
    publicKey: interKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
  });
  return { root, interKeys, intermediate };
}

const { root, interKeys, intermediate } = await makeChain();
const interKeyPem = await exportPrivateKeyPem(interKeys.privateKey);
const CA_ID = 1;

function toSqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

interface CertRow {
  username: string;
  serial: string;
  status: string;
  ca_id: number;
}

interface DownloadRow {
  username: string;
  serial: string;
  token_sha256: string;
  p12_encrypted: string;
  expires_at: string;
  downloaded_at: string | null;
}

function setUpMockDb(overrides: { enabled?: number; platform?: string } = {}) {
  const device = {
    username: 'vpn-juan-phone',
    platform: overrides.platform ?? 'android',
    cert_days: null,
    renew_after_days: null,
    enabled: overrides.enabled ?? 1,
  };
  const caRow = {
    id: CA_ID,
    status: 'active',
    cert_pem: intermediate.toString(),
    root_cert_pem: root.toString(),
    private_key_encrypted: encryptPkiPrivateKey(interKeyPem),
  };
  const settings = {
    vpn_fqdn: 'vpn.vlc.didev.es',
    aaa_id: 'CN=radius.vpn.vlc.didev.es',
    pool_start: '192.168.10.75',
    pool_end: '192.168.10.99',
    lan_cidr: '192.168.10.0/24',
    dns: '',
    device_cert_days: 30,
    renew_after_days: 20,
    overlap_hours: 48,
    android_cert_days: 365,
    est_url: 'https://pki.vlc.didev.es:8443',
  };
  const certificates = new Map<string, CertRow>();
  const downloads = new Map<string, DownloadRow>();

  mock.method(pools.panelPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes('FROM panel_vpn_devices WHERE username')) {
      return [p.u === device.username ? [device] : [], []];
    }
    if (sql.includes("FROM panel_pki_ca WHERE status = 'active'")) return [[caRow], []];
    if (sql.includes('FROM panel_pki_ca WHERE status IN')) {
      return [[{ root_cert_pem: caRow.root_cert_pem }], []];
    }
    if (sql.includes('FROM panel_vpn_settings')) return [[settings], []];
    if (sql.startsWith('INSERT INTO panel_vpn_android_downloads')) {
      downloads.set(String(p.tokenSha256), {
        username: String(p.username),
        serial: String(p.serial),
        token_sha256: String(p.tokenSha256),
        p12_encrypted: String(p.p12),
        expires_at: toSqlDateTime(p.expiresAt as Date),
        downloaded_at: null,
      });
      return [{ insertId: 1 }, []];
    }
    if (sql.startsWith('UPDATE panel_vpn_android_downloads')) {
      const row = downloads.get(String(p.t));
      const notExpired = row && Date.parse(`${row.expires_at.replace(' ', 'T')}Z`) > Date.now();
      const ok = !!row && row.username === p.u && !row.downloaded_at && notExpired;
      if (ok) row!.downloaded_at = toSqlDateTime(new Date());
      return [{ affectedRows: ok ? 1 : 0 }, []];
    }
    if (sql.startsWith('SELECT p12_encrypted FROM panel_vpn_android_downloads')) {
      const row = downloads.get(String(p.t));
      return [row && row.username === p.u ? [{ p12_encrypted: row.p12_encrypted }] : [], []];
    }
    if (sql.startsWith('DELETE FROM panel_vpn_android_downloads WHERE username')) {
      downloads.delete(String(p.t));
      return [{}, []];
    }
    if (sql.startsWith('DELETE FROM panel_vpn_android_downloads WHERE expires_at')) {
      let removed = 0;
      const now = Date.now();
      for (const [key, row] of downloads) {
        if (Date.parse(`${row.expires_at.replace(' ', 'T')}Z`) < now) {
          downloads.delete(key);
          removed++;
        }
      }
      return [{ affectedRows: removed }, []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  mock.method(pools.radiusPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes("FROM vpn_certificates WHERE username") && sql.includes("status = 'active'")) {
      const row = [...certificates.values()].find((c) => c.username === p.u && c.status === 'active');
      return [row ? [row] : [], []];
    }
    if (sql.startsWith('INSERT INTO vpn_certificates')) {
      certificates.set(String(p.serial), {
        username: String(p.username),
        serial: String(p.serial),
        status: 'active',
        ca_id: Number(p.caId),
      });
      return [{ insertId: certificates.size }, []];
    }
    if (sql.includes("SET status = 'superseded'")) {
      const row = certificates.get(String(p.serial));
      if (row) row.status = 'superseded';
      return [{}, []];
    }
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);

  return { certificates, downloads };
}

test('issueAndroidCertificate: alta correcta, contrasena y token distintos en cada emision', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const a = await issueAndroidCertificate('vpn-juan-phone', 7);
  const b = await issueAndroidCertificate('vpn-juan-phone', 7);
  assert.equal(a.password.length, 20);
  assert.notEqual(a.password, b.password);
  assert.notEqual(a.downloadToken, b.downloadToken);
  assert.ok(new Date(a.expiresAt).getTime() > Date.now());
});

test('issueAndroidCertificate: rechaza un dispositivo que no es android', async (t) => {
  setUpMockDb({ platform: 'windows' });
  t.after(() => mock.restoreAll());
  await assert.rejects(issueAndroidCertificate('vpn-juan-phone', null), /no es Android/);
});

test('issueAndroidCertificate: rechaza un dispositivo deshabilitado', async (t) => {
  setUpMockDb({ enabled: 0 });
  t.after(() => mock.restoreAll());
  await assert.rejects(issueAndroidCertificate('vpn-juan-phone', null), /deshabilitado/);
});

test('issueAndroidCertificate: rechaza un dispositivo desconocido', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());
  await assert.rejects(issueAndroidCertificate('vpn-no-existe', null), /No existe/);
});

test('issueAndroidCertificate: una segunda emision supersede la anterior (solapamiento)', async (t) => {
  const { certificates } = setUpMockDb();
  t.after(() => mock.restoreAll());

  await issueAndroidCertificate('vpn-juan-phone', null);
  const firstSerials = [...certificates.keys()];
  assert.equal(firstSerials.length, 1);

  await issueAndroidCertificate('vpn-juan-phone', null);
  assert.equal(certificates.size, 2);
  const statuses = [...certificates.values()].map((c) => c.status).sort();
  assert.deepEqual(statuses, ['active', 'superseded']);
});

test('consumeAndroidDownload: descarga correcta desde la VPN, .sswan valido con el .p12 real', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const issued = await issueAndroidCertificate('vpn-juan-phone', null);
  const result = await consumeAndroidDownload('vpn-juan-phone', issued.downloadToken, '192.168.10.80');

  assert.equal(result.filename, 'vpn-juan-phone.sswan');
  const profile = JSON.parse(result.sswanJson);
  assert.match(profile.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(profile.type, 'ikev2-eap-tls');
  assert.equal(profile.remote.addr, 'vpn.vlc.didev.es');
  assert.equal(profile.remote.id, 'CN=radius.vpn.vlc.didev.es');
  assert.equal(profile.local.eap_id, 'vpn-juan-phone');
  assert.equal(profile['ike-proposal'], 'aes256gcm16-prfsha384-ecp384');
  assert.equal(profile['esp-proposal'], 'aes256gcm16-ecp384');
  assert.ok(!('split-tunneling' in profile), 'Android es siempre full tunnel');

  // El certificado embebido en remote.cert es de verdad la raiz.
  const embeddedRoot = new x509.X509Certificate(Buffer.from(profile.remote.cert, 'base64'));
  assert.equal(embeddedRoot.subject, root.subject);

  // El .p12 embebido en local.p12 es de verdad valido con la contrasena mostrada una vez.
  const dir = mkdtempSync(join(tmpdir(), 'radius-panel-android-p12-'));
  const p12File = join(dir, 'device.p12');
  writeFileSync(p12File, Buffer.from(profile.local.p12, 'base64'));
  const out = execFileSync(
    'openssl',
    ['pkcs12', '-info', '-in', p12File, '-passin', `pass:${issued.password}`, '-noenc'],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.match(out, /CN=vpn-juan-phone/);
});

test('consumeAndroidDownload: el enlace no sirve dos veces', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const issued = await issueAndroidCertificate('vpn-juan-phone', null);
  await consumeAndroidDownload('vpn-juan-phone', issued.downloadToken, '192.168.10.80');
  await assert.rejects(
    consumeAndroidDownload('vpn-juan-phone', issued.downloadToken, '192.168.10.80'),
    /invalido, caducado o ya usado/,
  );
});

test('consumeAndroidDownload: rechaza un token caducado', async (t) => {
  const { downloads } = setUpMockDb();
  t.after(() => mock.restoreAll());

  const issued = await issueAndroidCertificate('vpn-juan-phone', null);
  // Retrasa el reloj a mano: la fila ya esta "caducada" aunque nunca se descargo.
  for (const row of downloads.values()) row.expires_at = toSqlDateTime(new Date(Date.now() - 60_000));

  await assert.rejects(
    consumeAndroidDownload('vpn-juan-phone', issued.downloadToken, '192.168.10.80'),
    /invalido, caducado o ya usado/,
  );
});

test('consumeAndroidDownload: rechaza un token que no existe', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());
  await issueAndroidCertificate('vpn-juan-phone', null);
  await assert.rejects(
    consumeAndroidDownload('vpn-juan-phone', 'token-que-no-existe', '192.168.10.80'),
    /invalido, caducado o ya usado/,
  );
});

test('consumeAndroidDownload: rechaza una IP fuera de la VPN y de la LAN', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());
  const issued = await issueAndroidCertificate('vpn-juan-phone', null);
  await assert.rejects(
    consumeAndroidDownload('vpn-juan-phone', issued.downloadToken, '8.8.8.8'),
    /solo esta disponible desde la red local o la VPN/,
  );
});

test('consumeAndroidDownload: acepta una IP de la LAN aunque este fuera del pool de la VPN', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());
  const issued = await issueAndroidCertificate('vpn-juan-phone', null);
  // 192.168.10.10 esta en lan_cidr (192.168.10.0/24) pero no en pool_start/end (75-99).
  const result = await consumeAndroidDownload('vpn-juan-phone', issued.downloadToken, '192.168.10.10');
  assert.equal(result.filename, 'vpn-juan-phone.sswan');
});

test('el .p12 guardado en la base de datos esta cifrado con PKI_MASTER_KEY, no en claro', async (t) => {
  const { downloads } = setUpMockDb();
  t.after(() => mock.restoreAll());

  await issueAndroidCertificate('vpn-juan-phone', null);
  assert.equal(downloads.size, 1);
  const stored = [...downloads.values()][0]!.p12_encrypted;

  // Formato de boxWithKey: iv.tag.data en base64url, no el .p12 en claro.
  assert.match(stored, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(stored, /PRIVATE KEY/);

  // Pero descifra a un .p12 (DER: empieza por SEQUENCE, 0x30) valido de verdad.
  const p12Base64 = decryptAndroidP12(stored);
  const p12Bytes = Buffer.from(p12Base64, 'base64');
  assert.equal(p12Bytes[0], 0x30);
});

test('decryptAndroidP12: falla con una PKI_MASTER_KEY distinta a la de cifrado', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const issued = await issueAndroidCertificate('vpn-juan-phone', null);
  const original = config.pki.masterKey;
  config.pki.masterKey = 'v'.repeat(32);
  try {
    await assert.rejects(consumeAndroidDownload('vpn-juan-phone', issued.downloadToken, '192.168.10.80'));
  } finally {
    config.pki.masterKey = original;
  }
});

test('purgeExpiredAndroidDownloads: borra solo las filas caducadas', async (t) => {
  const { downloads } = setUpMockDb();
  t.after(() => mock.restoreAll());

  const issued1 = await issueAndroidCertificate('vpn-juan-phone', null);
  const issued2 = await issueAndroidCertificate('vpn-juan-phone', null);
  const rows = [...downloads.values()];
  // Caduca solo la primera fila a mano.
  rows[0]!.expires_at = toSqlDateTime(new Date(Date.now() - 60_000));

  const removed = await purgeExpiredAndroidDownloads();
  assert.equal(removed, 1);
  await assert.rejects(consumeAndroidDownload('vpn-juan-phone', issued1.downloadToken, '192.168.10.80'));
  await consumeAndroidDownload('vpn-juan-phone', issued2.downloadToken, '192.168.10.80');
});
