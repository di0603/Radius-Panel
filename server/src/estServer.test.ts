import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import * as pools from './db/pools.js';
import { config } from './config.js';
import { sha256 } from './lib/crypto.js';
import { encryptPkiPrivateKey } from './lib/pkiCrypto.js';
import { EC_P384_SIGNING_ALGORITHM, exportPrivateKeyPem, generateEcKeyPair, x509 } from './lib/x509.js';
import { startEstServer } from './estServer.js';

/**
 * Prueba el listener EST real (TLS real, sin mockear net/tls): arranca el
 * servidor de server/src/estServer.ts en un puerto efimero con certificados
 * generados en memoria y le habla por HTTPS de verdad, con node:https como
 * cliente. La base de datos si esta mockeada (mock.method sobre los pools),
 * como en el resto de tests de este proyecto.
 */

config.pki.masterKey = 'y'.repeat(32);

const DAY = 24 * 60 * 60 * 1000;

async function makeRootCa() {
  const keys = await generateEcKeyPair('P-384');
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root CA',
    keys,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 3650 * DAY),
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });
  return { keys, cert };
}

async function makeIntermediate(root: { keys: CryptoKeyPair; cert: x509.X509Certificate }) {
  const keys = await generateEcKeyPair('P-384');
  const cert = await x509.X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate CA',
    issuer: root.cert.subject,
    publicKey: keys.publicKey,
    signingKey: root.keys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
    ],
  });
  return { keys, cert };
}

/** Certificado de servidor TLS autofirmado, solo para que el listener de test tenga con que presentarse. */
async function makeServerCert() {
  const keys = await generateEcKeyPair('P-256');
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=localhost',
    keys,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + DAY),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], true),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }], false),
    ],
  });
  return { keys, cert };
}

async function makeDeviceCsr(cn: string) {
  const keys = await generateEcKeyPair('P-256');
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${cn}`,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  return { keys, csr };
}

const root = await makeRootCa();
const intermediate = await makeIntermediate(root);
const serverTls = await makeServerCert();
const CA_ID = 1;
const caRow = {
  id: CA_ID,
  status: 'active',
  cert_pem: intermediate.cert.toString(),
  root_cert_pem: root.cert.toString(),
  private_key_encrypted: encryptPkiPrivateKey(await exportPrivateKeyPem(intermediate.keys.privateKey)),
};

function toSqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

interface CertRow {
  id: number;
  username: string;
  serial: string;
  spki_sha256: string;
  ca_id: number;
  not_before: string;
  not_after: string;
  status: string;
  superseded_until: string | null;
  created_at: string;
}

function setUpMockDb() {
  const tokens = new Map<string, { username: string; expires_at: string; used_at: string | null }>();
  const certificates = new Map<string, CertRow>();
  const device = { username: 'vpn-juan-laptop', platform: 'linux', cert_days: null, renew_after_days: null, enabled: 1 };
  const settings = {
    vpn_fqdn: 'vpn.example.com',
    aaa_id: 'CN=radius.example.com',
    pool_start: '192.168.10.75',
    pool_end: '192.168.10.99',
    dns: '',
    device_cert_days: 30,
    renew_after_days: 20,
    overlap_hours: 48,
    android_cert_days: 365,
    est_url: 'https://est.example.com:8443',
  };

  mock.method(pools.panelPool, 'query', ((sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes("FROM panel_pki_ca WHERE status = 'active'")) return [[caRow], []];
    if (sql.includes('SELECT cert_pem FROM panel_pki_ca WHERE id')) return [[caRow], []];
    if (sql.includes('FROM panel_pki_ca WHERE status IN')) {
      return [[{ cert_pem: caRow.cert_pem, root_cert_pem: caRow.root_cert_pem }], []];
    }
    if (sql.includes('FROM panel_vpn_devices WHERE username')) {
      return [p.u === device.username ? [device] : [], []];
    }
    if (sql.startsWith('INSERT INTO panel_audit_log')) return [{}, []];
    if (sql.startsWith('UPDATE panel_vpn_enroll_tokens')) {
      const tok = tokens.get(String(p.hash));
      const ok = !!tok && tok.username === p.u && !tok.used_at && Date.parse(tok.expires_at) > Date.now();
      if (ok) tok!.used_at = toSqlDateTime(new Date());
      return [{ affectedRows: ok ? 1 : 0 }, []];
    }
    if (sql.includes('FROM panel_vpn_settings')) return [[settings], []];
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  mock.method(pools.radiusPool, 'query', ((sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes('FROM vpn_certificates WHERE serial')) {
      const row = certificates.get(String(p.serial));
      return [row ? [row] : [], []];
    }
    if (sql.includes('SELECT spki_sha256 FROM vpn_certificates')) {
      return [[...certificates.values()].filter((c) => c.username === p.u).map((c) => ({ spki_sha256: c.spki_sha256 })), []];
    }
    if (sql.includes('SELECT created_at FROM vpn_certificates')) {
      const rows = [...certificates.values()].filter((c) => c.username === p.u).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return [rows.length ? [rows[0]] : [], []];
    }
    if (sql.startsWith('INSERT INTO vpn_certificates')) {
      const row: CertRow = {
        id: certificates.size + 1,
        username: String(p.username),
        serial: String(p.serial),
        spki_sha256: String(p.spkiSha256),
        ca_id: Number(p.caId),
        not_before: String(p.notBefore),
        not_after: String(p.notAfter),
        status: 'active',
        superseded_until: null,
        created_at: toSqlDateTime(new Date(Date.now() - 13 * 60 * 60 * 1000)),
      };
      certificates.set(row.serial, row);
      return [{ insertId: row.id }, []];
    }
    if (sql.includes("SET status = 'superseded'")) {
      const row = certificates.get(String(p.serial));
      if (row) {
        row.status = 'superseded';
        row.superseded_until = String(p.until);
      }
      return [{}, []];
    }
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);

  return {
    tokens,
    certificates,
    addToken(plain: string, username = device.username) {
      tokens.set(sha256(plain), {
        username,
        expires_at: toSqlDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000)),
        used_at: null,
      });
    },
  };
}

function httpsRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    clientCert?: { cert: string; key: string };
  },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
        rejectUnauthorized: false, // el test no valida el cert de servidor: eso no es lo que se prueba aqui
        cert: options.clientCert?.cert,
        key: options.clientCert?.key,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * `timeout` es imprescindible: `curl version` (sin "--") interpreta "version"
 * como un host y se queda intentando resolverlo/conectar hasta el timeout de
 * red del sistema (varios minutos) en vez de fallar al momento. `--version`
 * es lo correcto, pero por si acaso el binario no lo soporta iguialmente se
 * limita el tiempo de espera.
 */
function hasCli(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

test('EST real: cacerts, simpleenroll y simplereenroll sobre TLS real', async (t) => {
  const db = setUpMockDb();
  const server = await startEstServer({
    cert: serverTls.cert.toString(),
    key: await exportPrivateKeyPem(serverTls.keys.privateKey),
    ca: `${intermediate.cert.toString()}\n${root.cert.toString()}`,
    port: 0,
    bind: '127.0.0.1',
  });
  t.after(() => {
    server?.close();
    mock.restoreAll();
  });
  const port = (server!.address() as AddressInfo).port;

  await t.test('GET cacerts: PKCS7 certs-only, base64', async () => {
    const res = await httpsRequest(port, { method: 'GET', path: '/.well-known/est/cacerts' });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/pkcs7-mime/);
    const certs = new x509.X509Certificates(res.body);
    assert.equal(certs.length, 2); // intermedia + raiz
  });

  let deviceCertPem = '';
  let deviceKeyPem = '';

  await t.test('POST simpleenroll: alta con HTTP Basic (usuario=dispositivo, contrasena=token)', async () => {
    db.addToken('el-token-de-alta');
    const { keys, csr } = await makeDeviceCsr('vpn-juan-laptop');
    const auth = Buffer.from('vpn-juan-laptop:el-token-de-alta').toString('base64');
    const res = await httpsRequest(port, {
      method: 'POST',
      path: '/.well-known/est/simpleenroll',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/pkcs10' },
      body: csr.toString('base64'),
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/pkcs7-mime/);
    const certs = new x509.X509Certificates(res.body);
    assert.equal(certs.length, 1);
    deviceCertPem = certs[0]!.toString();
    deviceKeyPem = await exportPrivateKeyPem(keys.privateKey);
    assert.equal(await certs[0]!.verify({ publicKey: intermediate.cert.publicKey }), true);
  });

  await t.test('POST simpleenroll: sin Authorization, 401', async () => {
    const { csr } = await makeDeviceCsr('vpn-juan-laptop');
    const res = await httpsRequest(port, {
      method: 'POST',
      path: '/.well-known/est/simpleenroll',
      body: csr.toString('base64'),
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST simplereenroll: renovacion con certificado de cliente real (mTLS)', async () => {
    const { csr } = await makeDeviceCsr('vpn-juan-laptop');
    const res = await httpsRequest(port, {
      method: 'POST',
      path: '/.well-known/est/simplereenroll',
      headers: { 'Content-Type': 'application/pkcs10' },
      body: csr.toString('base64'),
      clientCert: { cert: deviceCertPem, key: deviceKeyPem },
    });
    assert.equal(res.status, 200);
    const certs = new x509.X509Certificates(res.body);
    assert.equal(await certs[0]!.verify({ publicKey: intermediate.cert.publicKey }), true);
  });

  await t.test('POST simplereenroll: sin certificado de cliente, rechazado', async () => {
    const { csr } = await makeDeviceCsr('vpn-juan-laptop');
    const res = await httpsRequest(port, {
      method: 'POST',
      path: '/.well-known/est/simplereenroll',
      headers: { 'Content-Type': 'application/pkcs10' },
      body: csr.toString('base64'),
    });
    assert.equal(res.status, 401);
  });

  await t.test('interoperabilidad: openssl entiende el PKCS7 de cacerts', { skip: !hasCli('openssl') && 'openssl no disponible' }, async () => {
    const res = await httpsRequest(port, { method: 'GET', path: '/.well-known/est/cacerts' });
    const dir = mkdtempSync(join(tmpdir(), 'radius-panel-est-test-'));
    const p7File = join(dir, 'cacerts.p7b');
    writeFileSync(p7File, Buffer.from(res.body, 'base64'));
    const out = execFileSync(
      'openssl',
      ['pkcs7', '-inform', 'DER', '-in', p7File, '-print_certs', '-noout'],
      { encoding: 'utf8', timeout: 5000 },
    );
    // -noout + -print_certs sin -text no imprime nada si falla el parseo; que no lance ya es la prueba.
    assert.equal(typeof out, 'string');
  });

  await t.test(
    'interoperabilidad: curl consigue hablar con el listener EST',
    { skip: !hasCli('curl') && 'curl no disponible' },
    async () => {
      // execFile (async), no execFileSync: el servidor EST de esta prueba
      // vive en el mismo proceso Node que el test (startEstServer se llama
      // aqui arriba, no en un proceso aparte). execFileSync usa spawnSync,
      // que bloquea el event loop entero mientras curl esta en marcha; como
      // el propio proceso bloqueado es quien tiene que aceptar la conexion
      // TLS y responder, curl se queda esperando una respuesta que nunca
      // llega y acaba en ETIMEDOUT: no es un problema de curl/Schannel, sino
      // un interbloqueo del propio test. Con la version async el event loop
      // sigue libre para atender la peticion mientras curl corre aparte.
      //
      // Sin -o (el destino "nulo" no es el mismo en Windows y POSIX): el
      // cuerpo y el codigo de estado van los dos a stdout, separados por un
      // salto de linea que anade -w, y solo se mira la ultima linea.
      const { stdout } = await promisify(execFile)(
        'curl',
        // "localhost" (no la IP: el cert de prueba solo lleva SAN dns:localhost
        // y algunos backends TLS exigen que coincida incluso con -k/--insecure)
        // y -4 para no acabar en ::1, donde el servidor de prueba (solo en
        // 127.0.0.1) no escucha.
        ['-sk', '-4', '-w', '\n%{http_code}', `https://localhost:${port}/.well-known/est/cacerts`],
        { encoding: 'utf8', timeout: 5000 },
      );
      const lines = stdout.trim().split('\n');
      assert.equal(lines[lines.length - 1], '200');
    },
  );
});
