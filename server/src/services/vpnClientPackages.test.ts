import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { config } from '../config.js';
import { EC_P384_SIGNING_ALGORITHM, generateEcKeyPair, x509 } from '../lib/x509.js';
import { buildDevicePackage, __testing } from './vpnClientPackages.js';

/**
 * `buildDevicePackage` genera el zip (Windows) / tar.gz (Linux) que se
 * descarga desde la ficha del dispositivo. Aqui se prueban las plantillas
 * puras (sin red ni base de datos) y despues el empaquetado real,
 * descomprimiendo los bytes de verdad (no solo comprobando que "no lanza")
 * para poder afirmar que ningun fichero del paquete lleva una clave o un
 * secreto.
 */

config.pki.masterKey = 'z'.repeat(32);

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
  return { root, intermediate };
}

const { root, intermediate } = await makeChain();

const BASE_CTX = {
  username: 'vpn-juan-laptop',
  tunnelMode: 'full' as const,
  vpnFqdn: 'vpn.vlc.didev.es',
  aaaId: 'CN=radius.vpn.vlc.didev.es',
  estBase: 'https://pki.vlc.didev.es:8443/.well-known/est',
  rootPem: '-----BEGIN CERTIFICATE-----\nROOT\n-----END CERTIFICATE-----\n',
  intermediatePems: ['-----BEGIN CERTIFICATE-----\nINTER\n-----END CERTIFICATE-----\n'],
  chainPem: '-----BEGIN CERTIFICATE-----\nINTER\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nROOT\n-----END CERTIFICATE-----\n',
};

/* -------------------------- Plantillas puras -------------------------- */

test('windowsConfigJson: sin secretos, con los datos del ajuste y el dispositivo', () => {
  const json = JSON.parse(__testing.windowsConfigJson(BASE_CTX));
  assert.deepEqual(json, {
    connectionName: 'Casa',
    server: 'vpn.vlc.didev.es',
    serverName: 'radius.vpn.vlc.didev.es',
    splitTunnel: false,
    username: 'vpn-juan-laptop',
    estBase: 'https://pki.vlc.didev.es:8443/.well-known/est',
  });
});

test('windowsConfigJson: splitTunnel refleja el tunnelMode del dispositivo', () => {
  const json = JSON.parse(__testing.windowsConfigJson({ ...BASE_CTX, tunnelMode: 'split' }));
  assert.equal(json.splitTunnel, true);
});

test('linuxConfigSh: comillas simples con la comilla interna escapada', () => {
  const sh = __testing.linuxConfigSh({ ...BASE_CTX, username: "vpn-o'brien-laptop" });
  assert.match(sh, /USERNAME='vpn-o'\\''brien-laptop'/);
  assert.match(sh, /KEY_FILE='\/etc\/swanctl\/ecdsa\/vpn-o'\\''brien-laptop\.pem'/);
});

test('renderCasaConf: modo split enruta solo la LAN de casa', () => {
  const conf = __testing.renderCasaConf({ ...BASE_CTX, tunnelMode: 'split' });
  assert.match(conf, /remote_ts = 192\.168\.10\.0\/24/);
  assert.match(conf, /eap_id = vpn-juan-laptop/);
  assert.match(conf, /id = "CN=radius\.vpn\.vlc\.didev\.es"/);
});

test('renderCasaConf: modo full enruta todo el trafico', () => {
  const conf = __testing.renderCasaConf({ ...BASE_CTX, tunnelMode: 'full' });
  assert.match(conf, /remote_ts = 0\.0\.0\.0\/0,::\/0/);
});

const SECRET_MARKERS = [
  /PRIVATE KEY/,
  /BEGIN RSA/,
  /BEGIN EC/,
  /PKI_MASTER_KEY/,
  /token_sha256/i,
];

const STATIC_TEMPLATES: Record<string, string> = {
  'install.ps1': __testing.WINDOWS_INSTALL_PS1,
  'enroll.ps1': __testing.WINDOWS_ENROLL_PS1,
  'renew.ps1': __testing.WINDOWS_RENEW_PS1,
  'README.txt (windows)': __testing.WINDOWS_README,
  'vpn-enroll': __testing.LINUX_ENROLL_SH,
  'vpn-renew': __testing.LINUX_RENEW_SH,
  'vpn-renew.service': __testing.LINUX_SYSTEMD_SERVICE,
  'vpn-renew.timer': __testing.LINUX_SYSTEMD_TIMER,
  'README.txt (linux)': __testing.LINUX_README,
};

test('ninguna plantilla estatica contiene material secreto', () => {
  for (const [name, content] of Object.entries(STATIC_TEMPLATES)) {
    for (const marker of SECRET_MARKERS) {
      assert.doesNotMatch(content, marker, `${name} no deberia contener ${marker}`);
    }
  }
});

test('enroll.ps1 y renew.ps1 piden el token por pantalla, nunca como parametro', () => {
  assert.match(__testing.WINDOWS_ENROLL_PS1, /Read-Host -Prompt/);
  assert.doesNotMatch(__testing.WINDOWS_ENROLL_PS1, /\$args\[/);
});

test('vpn-enroll lee el token de la entrada estandar, nunca de $1/$2', () => {
  assert.match(__testing.LINUX_ENROLL_SH, /read -r -s -p/);
  assert.doesNotMatch(__testing.LINUX_ENROLL_SH, /\$1|\$2/);
});

test('splitCaChain: distingue la raiz autofirmada de la intermedia sea cual sea el orden', async () => {
  const rootKeys = await generateEcKeyPair('P-384');
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root',
    keys: rootKeys,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
  });
  const interKeys = await generateEcKeyPair('P-384');
  const inter = await x509.X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate',
    issuer: root.subject,
    publicKey: interKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
  });

  const { rootPem, intermediatePems } = __testing.splitCaChain(`${inter.toString()}\n${root.toString()}`);
  assert.equal(rootPem.trim(), root.toString().trim());
  assert.deepEqual(
    intermediatePems.map((p) => p.trim()),
    [inter.toString().trim()],
  );
});

/* ------------------------- Empaquetado end-to-end ------------------------- */

function setUpMockDb(overrides: { platform?: string; enabled?: number; framedIp?: string | null } = {}) {
  const device = {
    id: 1,
    username: 'vpn-juan-laptop',
    owner_user: 'juan',
    device_label: 'laptop',
    owner_name: 'Juan',
    platform: overrides.platform ?? 'windows',
    tunnel_mode: 'full',
    notes: null,
    cert_days: null,
    renew_after_days: null,
    framed_ip: overrides.framedIp === undefined ? '192.168.10.80' : overrides.framedIp,
    enabled: overrides.enabled ?? 1,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  };
  const settings = {
    vpn_fqdn: 'vpn.vlc.didev.es',
    aaa_id: 'CN=radius.vpn.vlc.didev.es',
    pool_start: '192.168.10.75',
    pool_end: '192.168.10.99',
    dns: '',
    device_cert_days: 30,
    renew_after_days: 20,
    overlap_hours: 48,
    android_cert_days: 365,
    est_url: 'https://pki.vlc.didev.es:8443',
  };

  mock.method(pools.panelPool, 'query', (async (sql: string) => {
    if (sql.includes('FROM panel_vpn_devices WHERE username')) return [[device], []];
    if (sql.includes('FROM panel_vpn_settings')) return [[settings], []];
    if (sql.includes('FROM panel_pki_ca WHERE status IN')) {
      return [[{ cert_pem: intermediate.toString(), root_cert_pem: root.toString() }], []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  mock.method(pools.radiusPool, 'query', (async (sql: string) => {
    if (sql.includes('FROM vpn_certificates WHERE username')) return [[], []];
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);
}

function readZipEntries(buf: Buffer): { name: string; content: Buffer }[] {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'zip sin End Of Central Directory');
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);

  const entries: { name: string; content: Buffer }[] = [];
  for (let i = 0; i < entryCount; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, 'entrada de directorio central invalida');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);

    entries.push({ name, content });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readTarEntries(buf: Buffer): { name: string; content: Buffer; mode: number }[] {
  const entries: { name: string; content: Buffer; mode: number }[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const mode = parseInt(header.toString('ascii', 100, 108).replace(/\0.*$/s, '').trim(), 8);
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim(), 8);
    const content = Buffer.from(buf.subarray(offset + 512, offset + 512 + size));
    entries.push({ name, content, mode });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('buildDevicePackage: windows genera un zip valido, sin secretos, con la cadena de la CA', async (t) => {
  setUpMockDb({ platform: 'windows' });
  t.after(() => mock.restoreAll());

  const pkg = await buildDevicePackage('vpn-juan-laptop');
  assert.equal(pkg.filename, 'vpn-vpn-juan-laptop-windows.zip');
  assert.equal(pkg.contentType, 'application/zip');
  assert.equal(pkg.buffer.subarray(0, 4).toString('hex'), '504b0304');

  const entries = readZipEntries(pkg.buffer);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, [
    'README.txt',
    'ca-intermediate-1.pem',
    'ca-root.pem',
    'config.json',
    'enroll.ps1',
    'install.ps1',
    'renew.ps1',
  ]);

  for (const entry of entries) {
    const text = entry.content.toString('utf8');
    for (const marker of SECRET_MARKERS) {
      assert.doesNotMatch(text, marker, `${entry.name} no deberia contener ${marker}`);
    }
  }

  const configJson = JSON.parse(entries.find((e) => e.name === 'config.json')!.content.toString('utf8'));
  assert.equal(configJson.username, 'vpn-juan-laptop');
  assert.equal(configJson.server, 'vpn.vlc.didev.es');
});

test('buildDevicePackage: linux genera un tar.gz valido, sin secretos, con permisos ejecutables', async (t) => {
  setUpMockDb({ platform: 'linux' });
  t.after(() => mock.restoreAll());

  const pkg = await buildDevicePackage('vpn-juan-laptop');
  assert.equal(pkg.filename, 'vpn-vpn-juan-laptop-linux.tar.gz');
  assert.equal(pkg.contentType, 'application/gzip');

  const tarBuf = gunzipSync(pkg.buffer);
  const entries = readTarEntries(tarBuf);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, [
    'vpn-client/README.txt',
    'vpn-client/ca-chain.pem',
    'vpn-client/casa.conf',
    'vpn-client/config.sh',
    'vpn-client/vpn-enroll',
    'vpn-client/vpn-renew',
    'vpn-client/vpn-renew.service',
    'vpn-client/vpn-renew.timer',
  ]);

  const enroll = entries.find((e) => e.name === 'vpn-client/vpn-enroll')!;
  assert.equal(enroll.mode & 0o777, 0o700);

  for (const entry of entries) {
    const text = entry.content.toString('utf8');
    for (const marker of SECRET_MARKERS) {
      assert.doesNotMatch(text, marker, `${entry.name} no deberia contener ${marker}`);
    }
  }

  const configSh = entries.find((e) => e.name === 'vpn-client/config.sh')!.content.toString('utf8');
  assert.match(configSh, /USERNAME='vpn-juan-laptop'/);
});

test('buildDevicePackage: rechaza un dispositivo android (todavia sin paquete)', async (t) => {
  setUpMockDb({ platform: 'android' });
  t.after(() => mock.restoreAll());

  await assert.rejects(buildDevicePackage('vpn-juan-laptop'), (err: unknown) => {
    assert.match((err as Error).message, /android/);
    return true;
  });
});

test('buildDevicePackage: rechaza un dispositivo dado de baja', async (t) => {
  setUpMockDb({ enabled: 0, framedIp: null });
  t.after(() => mock.restoreAll());

  await assert.rejects(buildDevicePackage('vpn-juan-laptop'), (err: unknown) => {
    assert.match((err as Error).message, /dado de baja/);
    return true;
  });
});

/* --------------------------- shellcheck (opcional) --------------------------- */

function hasCli(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

test(
  'shellcheck no encuentra problemas en vpn-enroll ni vpn-renew',
  { skip: !hasCli('shellcheck') && 'shellcheck no disponible' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'radius-panel-vpn-scripts-'));
    for (const [name, content] of [
      ['vpn-enroll', __testing.LINUX_ENROLL_SH],
      ['vpn-renew', __testing.LINUX_RENEW_SH],
      ['config.sh', __testing.linuxConfigSh(BASE_CTX)],
    ] as const) {
      writeFileSync(join(dir, name), content);
    }
    execFileSync('shellcheck', ['vpn-enroll', 'vpn-renew'], { cwd: dir, timeout: 5000 });
  },
);
