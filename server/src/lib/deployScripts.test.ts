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

/**
 * El script exige que TLS_CONFIG_FILE exista y que la linea "ca_path = ..."
 * (resuelta) coincida con CA_PATH. `withReloadInterval` incluye ademas
 * "ca_path_reload_interval", para que el script no intente reiniciar nada
 * (los tests no tienen un FreeRADIUS real al que reiniciar). `caPathLiteral`
 * permite escribir un valor con variables de FreeRADIUS (p.ej.
 * "${certdir}/vpn/ca") en vez del CA_PATH real, para probar la resolucion;
 * por defecto es el propio `caPath`. `withCaFile` anade una linea "ca_file"
 * (el script solo avisa si falta, no lo exige, pero probar tambien el caso
 * en que SI esta evita que ese aviso ensucie la salida de los demas tests).
 */
function writeTlsConfig(
  dir: string,
  caPath: string,
  withReloadInterval: boolean,
  options: { caPathLiteral?: string; withCaFile?: boolean } = {},
): string {
  const tlsConfigPath = join(dir, 'eap_vpn');
  const reloadLine = withReloadInterval ? '    ca_path_reload_interval = 900\n' : '';
  const caFileLine = options.withCaFile ? `    ca_file = "${join(dir, 'root-bundle.pem')}"\n` : '';
  writeFileSync(
    tlsConfigPath,
    `eap_vpn {\n  tls-config tls-vpn {\n    ca_path = "${options.caPathLiteral ?? caPath}"\n${caFileLine}${reloadLine}  }\n}\n`,
    'utf8',
  );
  return tlsConfigPath;
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
    const intermediateDir = join(dir, 'intermediates');
    const stateDir = join(dir, 'state');
    execFileSync('mkdir', ['-p', pkiDir, caPath, intermediateDir, stateDir]);

    writeFileSync(join(pkiDir, 'ca-chain.pem'), `${chain.intermediateCert.toString()}\n${chain.rootCert.toString()}`, 'utf8');
    writeFileSync(join(pkiDir, 'crl.pem'), crl.toString(), 'utf8');

    const rootPath = join(caPath, 'ca.pem');
    writeFileSync(rootPath, chain.rootCert.toString(), 'utf8');
    const rootSha256 = sha256Hex(chain.rootCert.rawData);

    // ca_path_reload_interval SI presente: el script no debe intentar
    // "freeradius -XC" ni systemctl (no hay un FreeRADIUS real en el test).
    const tlsConfigPath = writeTlsConfig(dir, caPath, true, { withCaFile: true });

    const configPath = writeConfig(dir, {
      PANEL_PKI_URL: `file://${pkiDir}`,
      CA_PATH: caPath,
      INTERMEDIATE_DIR: intermediateDir,
      ROOT_CERT_FILE: rootPath,
      ROOT_CERT_SHA256: rootSha256,
      FREERADIUS_SERVICE: 'freeradius-does-not-exist-in-this-test',
      FREERADIUS_BINARY: 'freeradius-does-not-exist-in-this-test',
      TLS_CONFIG_FILE: tlsConfigPath,
    });

    const firstRun = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: stateDir,
    });
    assert.equal(firstRun.status, 0, `primera ejecucion deberia salir 0: ${firstRun.stderr}`);
    // Con ca_file presente en TLS_CONFIG_FILE, no debe avisar de que falta.
    assert.doesNotMatch(firstRun.stderr, /no tiene ninguna linea 'ca_file/);

    // La intermedia va FUERA de ca_path (item 9): nunca su certificado ni un
    // enlace .0 dentro de CA_PATH, sea cual sea el resultado de rehash.
    assert.equal(existsSync(join(caPath, 'panel-intermediate-1.pem')), false);
    const installedIntermediate = readFileSync(join(intermediateDir, 'panel-intermediate-1.pem'), 'utf8');
    assert.equal(installedIntermediate.trim(), chain.intermediateCert.toString().trim());

    const installedCrl = readFileSync(join(caPath, 'panel-crl.pem'), 'utf8');
    assert.equal(installedCrl.trim(), crl.toString().trim());

    // `openssl rehash` sobre CA_PATH solo debe haber generado un enlace .r0
    // (CRL), nunca un .0 (certificado): confirma que la intermedia no dejo
    // ningun rastro de "ancla de confianza" ahi.
    const caPathEntries = execFileSync('ls', ['-1', caPath], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(caPathEntries.some((f) => /\.r0$/.test(f)), 'deberia haber un enlace .r0 para la CRL');
    assert.ok(!caPathEntries.some((f) => /\.0$/.test(f)), 'no deberia haber ningun enlace .0 (certificado) en ca_path');

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
  'freeradius-vpn-ca-sync.sh: el esquema nuevo (intermedia fuera de ca_path + ca_file) resuelve "unable to get certificate CRL" del esquema antiguo',
  { skip: !canRunHappyPath && 'openssl/openssl-rehash no disponibles' },
  async () => {
    // Reproduce el bug de raiz (item 9) con openssl verify directamente,
    // sin pasar por el script: X509_V_FLAG_PARTIAL_CHAIN (que activa
    // -partial_chain) hace que, si la intermedia esta DENTRO de ca_path, la
    // cadena termine ahi -la raiz nunca entra en la validacion- y entonces
    // no hay forma de comprobar la revocacion de la PROPIA intermedia (para
    // eso hace falta la CRL de la raiz, que solo el esquema nuevo aporta via
    // ca_file). Con la intermedia FUERA de ca_path (pasada por -untrusted,
    // como hace el cliente EAP-TLS de verdad) y la raiz+su CRL en ca_file,
    // la cadena si llega hasta la raiz y la comprobacion funciona.
    const chain = await buildTestChain();
    const intermediateCrl = await buildCrl({
      issuerCert: chain.intermediateCert,
      signingKey: chain.intermediateKeys.privateKey,
      entries: [],
      nextUpdateDays: 30,
    });
    const rootCrl = await buildCrl({
      issuerCert: chain.rootCert,
      signingKey: chain.rootKeys.privateKey,
      entries: [],
      nextUpdateDays: 30,
    });

    const deviceKeys = await generateEcKeyPair('P-384');
    const deviceCert = await x509.X509CertificateGenerator.create({
      subject: 'CN=vpn-test-device',
      issuer: chain.intermediateCert.subject,
      publicKey: deviceKeys.publicKey,
      signingKey: chain.intermediateKeys.privateKey,
      signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 30 * 86_400_000),
      extensions: [
        new x509.BasicConstraintsExtension(false),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
      ],
    });

    const dir = mkdtempSync(join(tmpdir(), 'freeradius-ca-sync-verify-'));
    const rootPemPath = join(dir, 'root.pem');
    const intermediatePemPath = join(dir, 'intermediate.pem');
    const devicePemPath = join(dir, 'device.pem');
    writeFileSync(rootPemPath, chain.rootCert.toString(), 'utf8');
    writeFileSync(intermediatePemPath, chain.intermediateCert.toString(), 'utf8');
    writeFileSync(devicePemPath, deviceCert.toString(), 'utf8');

    // Esquema ANTIGUO (con bug): ca_path lleva la raiz, la intermedia Y su
    // CRL juntas, tal como hacia el script antes de este cambio.
    const oldCaPath = join(dir, 'ca_path_old');
    execFileSync('mkdir', ['-p', oldCaPath]);
    writeFileSync(join(oldCaPath, 'root.pem'), chain.rootCert.toString(), 'utf8');
    writeFileSync(join(oldCaPath, 'intermediate.pem'), chain.intermediateCert.toString(), 'utf8');
    writeFileSync(join(oldCaPath, 'intermediate-crl.pem'), intermediateCrl.toString(), 'utf8');
    execFileSync('openssl', ['rehash', oldCaPath], { timeout: 5000 });

    const oldResult = (() => {
      try {
        execFileSync(
          'openssl',
          ['verify', '-CApath', oldCaPath, '-partial_chain', '-untrusted', intermediatePemPath, '-crl_check_all', devicePemPath],
          { timeout: 5000, encoding: 'utf8', stdio: 'pipe' },
        );
        return { status: 0, output: '' };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    })();
    assert.notEqual(oldResult.status, 0, 'el esquema antiguo deberia fallar la verificacion');
    assert.match(oldResult.output, /unable to get certificate CRL/);

    // Esquema NUEVO (item 9): ca_path lleva SOLO la raiz + la CRL de la
    // intermedia (nunca la intermedia); ca_file lleva la raiz + su propia
    // CRL, para poder validar la revocacion de la intermedia.
    const newCaPath = join(dir, 'ca_path_new');
    execFileSync('mkdir', ['-p', newCaPath]);
    writeFileSync(join(newCaPath, 'root.pem'), chain.rootCert.toString(), 'utf8');
    writeFileSync(join(newCaPath, 'intermediate-crl.pem'), intermediateCrl.toString(), 'utf8');
    execFileSync('openssl', ['rehash', newCaPath], { timeout: 5000 });

    const caFilePath = join(dir, 'root-bundle.pem');
    writeFileSync(caFilePath, `${chain.rootCert.toString()}\n${rootCrl.toString()}`, 'utf8');

    execFileSync(
      'openssl',
      [
        'verify',
        '-CApath',
        newCaPath,
        '-CAfile',
        caFilePath,
        '-partial_chain',
        '-untrusted',
        intermediatePemPath,
        '-crl_check_all',
        devicePemPath,
      ],
      { timeout: 5000, encoding: 'utf8', stdio: 'pipe' },
    );
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
    const intermediateDir = join(dir, 'intermediates');
    execFileSync('mkdir', ['-p', pkiDir, caPath, intermediateDir]);

    writeFileSync(join(pkiDir, 'ca-chain.pem'), `${chain.intermediateCert.toString()}\n${chain.rootCert.toString()}`, 'utf8');
    writeFileSync(join(pkiDir, 'crl.pem'), crl.toString(), 'utf8');

    const rootPath = join(caPath, 'ca.pem');
    writeFileSync(rootPath, chain.rootCert.toString(), 'utf8');
    const tlsConfigPath = writeTlsConfig(dir, caPath, false);

    const configPath = writeConfig(dir, {
      PANEL_PKI_URL: `file://${pkiDir}`,
      CA_PATH: caPath,
      INTERMEDIATE_DIR: intermediateDir,
      ROOT_CERT_FILE: rootPath,
      ROOT_CERT_SHA256: '0'.repeat(64), // deliberadamente incorrecta
      FREERADIUS_SERVICE: 'freeradius-does-not-exist-in-this-test',
      FREERADIUS_BINARY: 'freeradius-does-not-exist-in-this-test',
      TLS_CONFIG_FILE: tlsConfigPath,
    });

    const result = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: join(dir, 'state'),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no coincide/);
    assert.equal(existsSync(join(caPath, 'panel-intermediate-1.pem')), false, 'no debe escribir nada si la raiz no coincide');
    assert.equal(existsSync(join(intermediateDir, 'panel-intermediate-1.pem')), false);
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
    const intermediateDir = join(dir, 'intermediates');
    execFileSync('mkdir', ['-p', pkiDir, caPath, intermediateDir]);

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
    const tlsConfigPath = writeTlsConfig(dir, caPath, false);

    const configPath = writeConfig(dir, {
      PANEL_PKI_URL: `file://${pkiDir}`,
      CA_PATH: caPath,
      INTERMEDIATE_DIR: intermediateDir,
      ROOT_CERT_FILE: rootPath,
      ROOT_CERT_SHA256: rootSha256,
      FREERADIUS_SERVICE: 'freeradius-does-not-exist-in-this-test',
      FREERADIUS_BINARY: 'freeradius-does-not-exist-in-this-test',
      TLS_CONFIG_FILE: tlsConfigPath,
    });

    const result = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: join(dir, 'state'),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no verifica contra la raiz local/);
    assert.equal(existsSync(join(caPath, 'panel-intermediate-1.pem')), false);
    assert.equal(existsSync(join(intermediateDir, 'panel-intermediate-1.pem')), false);
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
    const intermediateDir = join(dir, 'intermediates');
    execFileSync('mkdir', ['-p', pkiDir, caPath, intermediateDir]);

    writeFileSync(join(pkiDir, 'ca-chain.pem'), `${chain.intermediateCert.toString()}\n${chain.rootCert.toString()}`, 'utf8');
    writeFileSync(join(pkiDir, 'crl.pem'), expiredCrl.toString(), 'utf8');

    const rootPath = join(caPath, 'ca.pem');
    writeFileSync(rootPath, chain.rootCert.toString(), 'utf8');
    const rootSha256 = sha256Hex(chain.rootCert.rawData);
    const tlsConfigPath = writeTlsConfig(dir, caPath, false);

    const configPath = writeConfig(dir, {
      PANEL_PKI_URL: `file://${pkiDir}`,
      CA_PATH: caPath,
      INTERMEDIATE_DIR: intermediateDir,
      ROOT_CERT_FILE: rootPath,
      ROOT_CERT_SHA256: rootSha256,
      FREERADIUS_SERVICE: 'freeradius-does-not-exist-in-this-test',
      FREERADIUS_BINARY: 'freeradius-does-not-exist-in-this-test',
      TLS_CONFIG_FILE: tlsConfigPath,
    });

    const result = runSyncScript({
      FREERADIUS_VPN_CA_SYNC_CONFIG: configPath,
      FREERADIUS_VPN_CA_SYNC_STATE_DIR: join(dir, 'state'),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /caducado/);
    assert.equal(existsSync(join(caPath, 'panel-intermediate-1.pem')), false);
    assert.equal(existsSync(join(intermediateDir, 'panel-intermediate-1.pem')), false);
  },
);
