import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrl } from '../services/pki.js';
import { EC_P384_SIGNING_ALGORITHM, generateEcKeyPair, sha256Hex, x509 } from './x509.js';

/**
 * `deploy/vpn-gateway-agent.sh` y `deploy/freeradius-vpn-ca-sync.sh` corren
 * sin supervision (systemd timer): shellcheck sobre el fichero real, no
 * solo sobre una plantilla en memoria como en vpnClientPackages.test.ts.
 */
const DEPLOY_DIR = join(import.meta.dirname, '..', '..', '..', 'deploy');
const SYNC_SCRIPT = join(DEPLOY_DIR, 'freeradius-vpn-ca-sync.sh');

function hasCli(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * `openssl rehash` (usado por el propio script, ver freeradius-vpn-ca-sync.sh)
 * exige symlinks: algunas builds de OpenSSL para Windows (la que trae Git
 * for Windows incluida) lo deshabilitan ("Not available; use c_rehash
 * script") y no hay forma de solucionarlo desde aqui -es una limitacion del
 * binario, no de este script ni de este test-. En Linux (la .28 real)
 * funciona siempre. Se comprueba de verdad (no solo --help) para no dar un
 * falso positivo de "disponible".
 */
function hasWorkingOpensslRehash(): boolean {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'openssl-rehash-probe-'));
    execFileSync('openssl', ['rehash', dir], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

test(
  'shellcheck no encuentra problemas en deploy/vpn-gateway-agent.sh',
  { skip: !hasCli('shellcheck') && 'shellcheck no disponible' },
  () => {
    execFileSync('shellcheck', ['vpn-gateway-agent.sh'], { cwd: DEPLOY_DIR, timeout: 5000 });
  },
);

test(
  'shellcheck no encuentra problemas en deploy/freeradius-vpn-ca-sync.sh',
  { skip: !hasCli('shellcheck') && 'shellcheck no disponible' },
  () => {
    execFileSync('shellcheck', ['freeradius-vpn-ca-sync.sh'], { cwd: DEPLOY_DIR, timeout: 5000 });
  },
);

/**
 * Integracion real de deploy/freeradius-vpn-ca-sync.sh contra una CA de
 * prueba generada al vuelo (misma forma que produce el panel de verdad:
 * @peculiar/x509, no unas plantillas de texto). Usa file:// para
 * PANEL_PKI_URL (curl lo soporta de serie: nos ahorra levantar un servidor
 * HTTP solo para el test) y un ca_path/estado en un directorio temporal, sin
 * tocar nada real. Solo corre si hay bash+openssl+curl (siempre en la .28
 * real; en Windows requiere Git Bash, que es justo donde corre este test).
 */
const canRunSyncIntegration = hasCli('bash') && hasCli('openssl') && hasCli('curl');
// Solo el camino feliz llega a "openssl rehash" (los rechazos salen antes):
// separado para no perder cobertura de los rechazos en un entorno sin rehash.
const canRunHappyPath = canRunSyncIntegration && hasWorkingOpensslRehash();

async function buildTestChain() {
  const rootKeys = await generateEcKeyPair('P-384');
  const rootCert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root CA',
    keys: rootKeys,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 3650 * 86_400_000),
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  const intermediateKeys = await generateEcKeyPair('P-384');
  const intermediateCert = await x509.X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate CA',
    issuer: rootCert.subject,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 1825 * 86_400_000),
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
    ],
  });

  return { rootCert, rootKeys, intermediateCert, intermediateKeys };
}

interface SyncRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runSyncScript(env: Record<string, string>): SyncRunResult {
  try {
    const stdout = execFileSync('bash', [SYNC_SCRIPT], {
      env: { ...process.env, ...env },
      timeout: 15_000,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function writeConfig(dir: string, overrides: Record<string, string>): string {
  const configPath = join(dir, 'config.sh');
  const lines = Object.entries(overrides).map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`);
  writeFileSync(configPath, lines.join('\n') + '\n', 'utf8');
  return configPath;
}

test(
  'freeradius-vpn-ca-sync.sh: sincroniza una intermedia+CRL reales, sin tocar la raiz, e idempotente',
  { skip: !canRunHappyPath && 'bash/openssl/curl/openssl-rehash no disponibles' },
  async () => {
    const chain = await buildTestChain();
    const crl = await buildCrl({
      issuerCert: chain.intermediateCert,
      signingKey: chain.intermediateKeys.privateKey,
      entries: [],
      nextUpdateDays: 30,
    });

    const dir = mkdtempSync(join(tmpdir(), 'freeradius-ca-sync-'));
    const pkiDir = join(dir, 'pki');
    const caPath = join(dir, 'ca_path');
    const stateDir = join(dir, 'state');
    execFileSync('mkdir', ['-p', pkiDir, caPath, stateDir]);

    writeFileSync(join(pkiDir, 'ca-chain.pem'), `${chain.intermediateCert.toString()}\n${chain.rootCert.toString()}`, 'utf8');
    writeFileSync(join(pkiDir, 'crl.pem'), crl.toString(), 'utf8');

    const rootPath = join(caPath, 'ca.pem');
    writeFileSync(rootPath, chain.rootCert.toString(), 'utf8');
    const rootSha256 = sha256Hex(chain.rootCert.rawData);

    const tlsConfigPath = join(dir, 'tls-config-no-reload-interval.conf');
    writeFileSync(tlsConfigPath, 'eap {\n  tls-config tls-common {\n  }\n}\n', 'utf8');

    const configPath = writeConfig(dir, {
      PANEL_PKI_URL: `file://${pkiDir}`,
      CA_PATH: caPath,
      ROOT_CERT_FILE: rootPath,
      ROOT_CERT_SHA256: rootSha256,
      FREERADIUS_SERVICE: 'freeradius-does-not-exist-in-this-test',
      TLS_CONFIG_FILE: tlsConfigPath,
    });

    const firstRun = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: stateDir,
    });
    assert.equal(firstRun.status, 0, `primera ejecucion deberia salir 0: ${firstRun.stderr}`);

    const installedIntermediate = readFileSync(join(caPath, 'panel-intermediate-1.pem'), 'utf8');
    assert.equal(installedIntermediate.trim(), chain.intermediateCert.toString().trim());

    const installedCrl = readFileSync(join(caPath, 'panel-crl.pem'), 'utf8');
    assert.equal(installedCrl.trim(), crl.toString().trim());

    // La raiz (ca.pem) no se toca: sigue siendo exactamente lo que era.
    assert.equal(readFileSync(rootPath, 'utf8').trim(), chain.rootCert.toString().trim());

    // TLS_CONFIG_FILE dice que hay ca_path_reload_interval: nunca deberia
    // haber intentado systemctl (si lo hubiera intentado con un servicio
    // inexistente, habria fallado y devuelto un exit code distinto de 0).
    assert.match(firstRun.stdout, /ca_path_reload_interval/);

    const secondRun = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: stateDir,
    });
    assert.equal(secondRun.status, 0);
    assert.match(secondRun.stdout, /[Ss]in cambios/);
  },
);

test(
  'freeradius-vpn-ca-sync.sh: rechaza si la raiz local no coincide con ROOT_CERT_SHA256 (nunca confia en la raiz del HTTP)',
  { skip: !canRunSyncIntegration && 'bash/openssl/curl no disponibles' },
  async () => {
    const chain = await buildTestChain();
    const crl = await buildCrl({
      issuerCert: chain.intermediateCert,
      signingKey: chain.intermediateKeys.privateKey,
      entries: [],
      nextUpdateDays: 30,
    });

    const dir = mkdtempSync(join(tmpdir(), 'freeradius-ca-sync-badroot-'));
    const pkiDir = join(dir, 'pki');
    const caPath = join(dir, 'ca_path');
    execFileSync('mkdir', ['-p', pkiDir, caPath]);

    writeFileSync(join(pkiDir, 'ca-chain.pem'), `${chain.intermediateCert.toString()}\n${chain.rootCert.toString()}`, 'utf8');
    writeFileSync(join(pkiDir, 'crl.pem'), crl.toString(), 'utf8');

    const rootPath = join(caPath, 'ca.pem');
    writeFileSync(rootPath, chain.rootCert.toString(), 'utf8');

    const configPath = writeConfig(dir, {
      PANEL_PKI_URL: `file://${pkiDir}`,
      CA_PATH: caPath,
      ROOT_CERT_FILE: rootPath,
      ROOT_CERT_SHA256: '0'.repeat(64), // deliberadamente incorrecta
      FREERADIUS_SERVICE: 'freeradius-does-not-exist-in-this-test',
      TLS_CONFIG_FILE: join(dir, 'no-existe.conf'),
    });

    const result = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: join(dir, 'state'),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no coincide/);
    assert.equal(existsSync(join(caPath, 'panel-intermediate-1.pem')), false, 'no debe escribir nada si la raiz no coincide');
  },
);

test(
  'freeradius-vpn-ca-sync.sh: rechaza una intermedia que NO cuelga de la raiz local, aunque el sobre HTTP la acompane de "su propia raiz"',
  { skip: !canRunSyncIntegration && 'bash/openssl/curl no disponibles' },
  async () => {
    const trustedChain = await buildTestChain();
    // Una segunda CA totalmente distinta: simula un servidor comprometido o
    // mal configurado que sirve una cadena que no cuelga de la raiz real.
    const otherChain = await buildTestChain();
    const rogueCrl = await buildCrl({
      issuerCert: otherChain.intermediateCert,
      signingKey: otherChain.intermediateKeys.privateKey,
      entries: [],
      nextUpdateDays: 30,
    });

    const dir = mkdtempSync(join(tmpdir(), 'freeradius-ca-sync-rogue-'));
    const pkiDir = join(dir, 'pki');
    const caPath = join(dir, 'ca_path');
    execFileSync('mkdir', ['-p', pkiDir, caPath]);

    // El servidor HTTP (comprometido/erroneo) sirve la intermedia AJENA,
    // seguida de SU PROPIA raiz -que el script debe descartar sin usarla-.
    writeFileSync(
      join(pkiDir, 'ca-chain.pem'),
      `${otherChain.intermediateCert.toString()}\n${otherChain.rootCert.toString()}`,
      'utf8',
    );
    writeFileSync(join(pkiDir, 'crl.pem'), rogueCrl.toString(), 'utf8');

    const rootPath = join(caPath, 'ca.pem');
    writeFileSync(rootPath, trustedChain.rootCert.toString(), 'utf8');
    const rootSha256 = sha256Hex(trustedChain.rootCert.rawData);

    const configPath = writeConfig(dir, {
      PANEL_PKI_URL: `file://${pkiDir}`,
      CA_PATH: caPath,
      ROOT_CERT_FILE: rootPath,
      ROOT_CERT_SHA256: rootSha256,
      FREERADIUS_SERVICE: 'freeradius-does-not-exist-in-this-test',
      TLS_CONFIG_FILE: join(dir, 'no-existe.conf'),
    });

    const result = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: join(dir, 'state'),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no verifica contra la raiz local/);
    assert.equal(existsSync(join(caPath, 'panel-intermediate-1.pem')), false);
  },
);

test(
  'freeradius-vpn-ca-sync.sh: rechaza una CRL ya caducada',
  { skip: !canRunSyncIntegration && 'bash/openssl/curl no disponibles' },
  async () => {
    const chain = await buildTestChain();
    const expiredCrl = await buildCrl({
      issuerCert: chain.intermediateCert,
      signingKey: chain.intermediateKeys.privateKey,
      entries: [],
      thisUpdate: new Date(Date.now() - 10 * 86_400_000),
      nextUpdateDays: -3, // nextUpdate hace 3 dias: ya caducada
    });

    const dir = mkdtempSync(join(tmpdir(), 'freeradius-ca-sync-expiredcrl-'));
    const pkiDir = join(dir, 'pki');
    const caPath = join(dir, 'ca_path');
    execFileSync('mkdir', ['-p', pkiDir, caPath]);

    writeFileSync(join(pkiDir, 'ca-chain.pem'), `${chain.intermediateCert.toString()}\n${chain.rootCert.toString()}`, 'utf8');
    writeFileSync(join(pkiDir, 'crl.pem'), expiredCrl.toString(), 'utf8');

    const rootPath = join(caPath, 'ca.pem');
    writeFileSync(rootPath, chain.rootCert.toString(), 'utf8');
    const rootSha256 = sha256Hex(chain.rootCert.rawData);

    const configPath = writeConfig(dir, {
      PANEL_PKI_URL: `file://${pkiDir}`,
      CA_PATH: caPath,
      ROOT_CERT_FILE: rootPath,
      ROOT_CERT_SHA256: rootSha256,
      FREERADIUS_SERVICE: 'freeradius-does-not-exist-in-this-test',
      TLS_CONFIG_FILE: join(dir, 'no-existe.conf'),
    });

    const result = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: join(dir, 'state'),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /caducado/);
    assert.equal(existsSync(join(caPath, 'panel-intermediate-1.pem')), false);
  },
);
