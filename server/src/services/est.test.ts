import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { config } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { encryptPkiPrivateKey } from '../lib/pkiCrypto.js';
import {
  EC_P384_SIGNING_ALGORITHM,
  exportPrivateKeyPem,
  generateEcKeyPair,
  sha256Hex,
  x509,
} from '../lib/x509.js';
import {
  RENEW_MIN_INTERVAL_HOURS,
  claimEnrollToken,
  enrollDevice,
  type EstRejection,
  getStatus,
  toIsoUtc,
  renewDevice,
} from './est.js';

// decryptPkiPrivateKey/encryptPkiPrivateKey leen config.pki.masterKey en cada
// llamada (no al importar), asi que basta con rellenarlo aqui: es un objeto
// normal, no una exportacion de solo lectura, y este proceso es propio de
// este fichero de test (node:test arranca un proceso por fichero).
config.pki.masterKey = 'x'.repeat(32);

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function toSqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/* --------------------------------- Fixtures -------------------------------- */

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
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });
  return { keys, cert };
}

async function makeIntermediate(root: TestCa): Promise<TestCa> {
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

/** Certificado de dispositivo "a mano" (no via signDeviceCsr): permite forzar fechas para los tests de rechazo. */
async function makeDeviceCert(
  ca: TestCa,
  cn: string,
  overrides: { notBefore?: Date; notAfter?: Date } = {},
): Promise<{ keys: CryptoKeyPair; cert: x509.X509Certificate; csrPem: string }> {
  const keys = await generateEcKeyPair('P-256');
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${cn}`,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  const cert = await x509.X509CertificateGenerator.create({
    subject: `CN=${cn}`,
    issuer: ca.cert.subject,
    publicKey: keys.publicKey,
    signingKey: ca.keys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: overrides.notBefore ?? new Date(Date.now() - DAY),
    notAfter: overrides.notAfter ?? new Date(Date.now() + 30 * DAY),
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: cn }], false),
    ],
  });
  return { keys, cert, csrPem: csr.toString() };
}

const root = await makeRootCa();
const intermediateA = await makeIntermediate(root);
const otherRoot = await makeRootCa();
const intermediateB = await makeIntermediate(otherRoot); // "otra CA", ajena a intermediateA

const CA_A_ID = 1;
const CA_B_ID = 2;

/* ------------------------------- Fake DB en memoria ------------------------------- */

interface FakeDevice {
  username: string;
  platform: 'windows' | 'android' | 'linux';
  cert_days: number | null;
  renew_after_days: number | null;
  enabled: number;
}

interface FakeCertRow {
  id: number;
  username: string;
  serial: string;
  spki_sha256: string;
  ca_id: number | null;
  not_before: string;
  not_after: string;
  status: 'active' | 'superseded' | 'revoked';
  superseded_until: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface FakeToken {
  username: string;
  token_sha256: string;
  expires_at: string;
  used_at: string | null;
}

interface FakeDb {
  device: FakeDevice | null;
  activeCaId: number | null;
  tokens: Map<string, FakeToken>;
  certificates: Map<string, FakeCertRow>;
  settings: Record<string, unknown>;
}

function defaultSettingsRow(): Record<string, unknown> {
  return {
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
    min_app_version: '1.4.0',
  };
}

function makeFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    device: {
      username: 'vpn-juan-laptop',
      platform: 'linux',
      cert_days: null,
      renew_after_days: null,
      enabled: 1,
    },
    activeCaId: CA_A_ID,
    tokens: new Map(),
    certificates: new Map(),
    settings: defaultSettingsRow(),
    ...overrides,
  };
}

const CA_ROWS: Record<number, { id: number; cert_pem: string; private_key_encrypted: string }> = {
  [CA_A_ID]: {
    id: CA_A_ID,
    cert_pem: intermediateA.cert.toString(),
    private_key_encrypted: '', // se rellena mas abajo (async)
  },
  [CA_B_ID]: {
    id: CA_B_ID,
    cert_pem: intermediateB.cert.toString(),
    private_key_encrypted: '',
  },
};
CA_ROWS[CA_A_ID]!.private_key_encrypted = encryptPkiPrivateKey(
  await exportPrivateKeyPem(intermediateA.keys.privateKey),
);
CA_ROWS[CA_B_ID]!.private_key_encrypted = encryptPkiPrivateKey(
  await exportPrivateKeyPem(intermediateB.keys.privateKey),
);

type QueryDispatch = (sql: string, params?: unknown) => unknown;

function panelDispatch(db: FakeDb): QueryDispatch {
  return (sql, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes("FROM panel_pki_ca WHERE status = 'active'")) {
      const row = db.activeCaId ? CA_ROWS[db.activeCaId] : undefined;
      return [row ? [row] : [], []];
    }
    if (sql.includes('SELECT cert_pem FROM panel_pki_ca WHERE id')) {
      const row = CA_ROWS[Number(p.id)];
      return [row ? [{ cert_pem: row.cert_pem }] : [], []];
    }
    if (sql.includes('FROM panel_vpn_devices WHERE username')) {
      const match = db.device && db.device.username === p.u ? [db.device] : [];
      return [match, []];
    }
    if (sql.includes('SET used_at = NULL')) {
      // releaseEnrollToken: contrapartida de la reclamacion, usada por
      // enrollDevice cuando firmar/insertar falla despues de reclamar.
      const tok = db.tokens.get(String(p.hash));
      if (tok && tok.username === p.u) tok.used_at = null;
      return [{}, []];
    }
    if (sql.startsWith('UPDATE panel_vpn_enroll_tokens')) {
      const tok = db.tokens.get(String(p.hash));
      const ok = !!tok && tok.username === p.u && !tok.used_at && Date.parse(tok.expires_at) > Date.now();
      if (ok) tok!.used_at = toSqlDateTime(new Date());
      return [{ affectedRows: ok ? 1 : 0 }, []];
    }
    if (sql.includes('FROM panel_vpn_settings')) {
      return [[db.settings], []];
    }
    throw new Error(`panelPool.query no esperado en el test: ${sql}`);
  };
}

function radiusDispatch(db: FakeDb): QueryDispatch {
  return (sql, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes('FROM vpn_certificates WHERE username')) {
      // Version bloqueada usada por renewDevice dentro de su transaccion
      // (ver el mutex de installFakeDb): tanto la de un solo serial como la
      // de todo el username devuelven la misma foto de db.certificates.
      const rows = [...db.certificates.values()].filter((c) => c.username === p.u);
      return [rows, []];
    }
    if (sql.includes('FROM vpn_certificates WHERE serial')) {
      const row = db.certificates.get(String(p.serial));
      return [row ? [row] : [], []];
    }
    if (sql.startsWith('INSERT INTO vpn_certificates')) {
      const row: FakeCertRow = {
        id: db.certificates.size + 1,
        username: String(p.username),
        serial: String(p.serial),
        spki_sha256: String(p.spkiSha256),
        ca_id: p.caId === undefined ? null : Number(p.caId),
        not_before: String(p.notBefore),
        not_after: String(p.notAfter),
        status: 'active',
        superseded_until: null,
        revoked_at: null,
        created_at: toSqlDateTime(new Date()),
      };
      db.certificates.set(row.serial, row);
      return [{ insertId: row.id }, []];
    }
    if (sql.includes("SET status = 'superseded'")) {
      const row = db.certificates.get(String(p.serial));
      if (row) {
        row.status = 'superseded';
        row.superseded_until = String(p.until);
      }
      return [{}, []];
    }
    throw new Error(`radiusPool.query no esperado en el test: ${sql}`);
  };
}

/**
 * Mutex FIFO por clave: simula el bloqueo de filas de un `SELECT ... FOR
 * UPDATE` real dentro de una transaccion. `acquire(key)` no se resuelve
 * hasta que el titular anterior de esa clave llama a la funcion de
 * liberacion que le devuelve -- asi el test de renovaciones concurrentes
 * puede comprobar que la segunda transaccion ve el estado que dejo la
 * primera, no uno obsoleto.
 */
function createKeyedMutex(): (key: string) => Promise<() => void> {
  const chains = new Map<string, Promise<void>>();
  return (key: string) => {
    const previous = chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    chains.set(
      key,
      previous.then(() => held),
    );
    return previous.then(() => release);
  };
}

/**
 * Instala los mocks de panelPool/radiusPool.query (como antes) y ademas
 * radiusPool.getConnection, que renewDevice usa para su transaccion. La
 * conexion falsa comparte el mismo `db` en memoria; su `SELECT ... WHERE
 * username ... FOR UPDATE` pasa por el mutex de arriba para que dos
 * renovaciones concurrentes del mismo dispositivo se serialicen igual que en
 * MySQL de verdad.
 */
function installFakeDb(db: FakeDb): void {
  mock.method(pools.panelPool, 'query', panelDispatch(db) as never);
  const dispatch = radiusDispatch(db);
  mock.method(pools.radiusPool, 'query', dispatch as never);

  const acquire = createKeyedMutex();
  mock.method(
    pools.radiusPool,
    'getConnection',
    (async () => {
      let unlock: (() => void) | null = null;
      return {
        query: async (sql: string, params?: Record<string, unknown>) => {
          if (sql.includes('FROM vpn_certificates WHERE username') && sql.includes('FOR UPDATE')) {
            unlock = await acquire(String(params?.u));
          }
          return dispatch(sql, params);
        },
        beginTransaction: async () => {},
        commit: async () => {
          unlock?.();
          unlock = null;
        },
        rollback: async () => {
          unlock?.();
          unlock = null;
        },
        release: () => {},
      };
    }) as unknown as typeof pools.radiusPool.getConnection,
  );
}

function addToken(db: FakeDb, plain: string, opts: { username?: string; expiresInMs?: number } = {}): void {
  const hash = sha256(plain);
  db.tokens.set(hash, {
    username: opts.username ?? db.device!.username,
    token_sha256: hash,
    expires_at: toSqlDateTime(new Date(Date.now() + (opts.expiresInMs ?? 24 * HOUR))),
    used_at: null,
  });
}

function addCertificate(db: FakeDb, cert: x509.X509Certificate, over: Partial<FakeCertRow> = {}): FakeCertRow {
  const row: FakeCertRow = {
    id: db.certificates.size + 1,
    username: db.device!.username,
    serial: cert.serialNumber.toLowerCase(),
    spki_sha256: sha256Hex(cert.publicKey.rawData),
    ca_id: CA_A_ID,
    not_before: toSqlDateTime(cert.notBefore),
    not_after: toSqlDateTime(cert.notAfter),
    status: 'active',
    superseded_until: null,
    revoked_at: null,
    created_at: toSqlDateTime(new Date(Date.now() - 13 * HOUR)),
    ...over,
  };
  db.certificates.set(row.serial, row);
  return row;
}

/* ---------------------------------- simpleenroll ---------------------------------- */

test('enrollDevice: alta correcta', async () => {
  const db = makeFakeDb();
  addToken(db, 'el-token-correcto');
  installFakeDb(db);
  try {
    const { csrPem } = await makeDeviceCert(intermediateA, db.device!.username);
    const result = await enrollDevice({ username: db.device!.username, token: 'el-token-correcto', csrBody: csrPem });
    assert.match(result.serial, /^[0-9a-f]{32}$/);
    const stored = db.certificates.get(result.serial);
    assert.equal(stored?.status, 'active');
    assert.equal(stored?.ca_id, CA_A_ID);
  } finally {
    mock.restoreAll();
  }
});

test('enrollDevice: rechaza un token ya usado', async () => {
  const db = makeFakeDb();
  addToken(db, 'usado');
  db.tokens.get([...db.tokens.keys()][0]!)!.used_at = toSqlDateTime(new Date());
  installFakeDb(db);
  try {
    const { csrPem } = await makeDeviceCert(intermediateA, db.device!.username);
    await assert.rejects(
      enrollDevice({ username: db.device!.username, token: 'usado', csrBody: csrPem }),
      /Dispositivo o token de alta invalidos/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('enrollDevice: rechaza un token caducado', async () => {
  const db = makeFakeDb();
  addToken(db, 'caducado', { expiresInMs: -1000 });
  installFakeDb(db);
  try {
    const { csrPem } = await makeDeviceCert(intermediateA, db.device!.username);
    await assert.rejects(
      enrollDevice({ username: db.device!.username, token: 'caducado', csrBody: csrPem }),
      /Dispositivo o token de alta invalidos/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('enrollDevice: rechaza un token de otro dispositivo', async () => {
  const db = makeFakeDb();
  addToken(db, 'de-otro', { username: 'vpn-otro-dispositivo' });
  installFakeDb(db);
  try {
    const { csrPem } = await makeDeviceCert(intermediateA, db.device!.username);
    await assert.rejects(
      enrollDevice({ username: db.device!.username, token: 'de-otro', csrBody: csrPem }),
      /Dispositivo o token de alta invalidos/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('enrollDevice: dispositivo inexistente y token incorrecto responden con el mismo mensaje', async () => {
  // El motivo real (EstRejection.reason) es distinto -- solo queda en la
  // auditoria -- pero el error que ve el cliente tiene que ser identico en
  // los dos casos, para no poder usar simpleenroll a modo de oraculo y
  // averiguar que usernames existen.
  const dbUnknownDevice = makeFakeDb({ device: null });
  installFakeDb(dbUnknownDevice);
  let unknownDeviceError: EstRejection;
  try {
    const { csrPem } = await makeDeviceCert(intermediateA, 'vpn-no-existe');
    try {
      await enrollDevice({ username: 'vpn-no-existe', token: 'lo-que-sea', csrBody: csrPem });
      assert.fail('deberia haber rechazado');
    } catch (err) {
      unknownDeviceError = err as EstRejection;
    }
  } finally {
    mock.restoreAll();
  }

  const dbWrongToken = makeFakeDb();
  addToken(dbWrongToken, 'el-correcto');
  installFakeDb(dbWrongToken);
  let wrongTokenError: EstRejection;
  try {
    const { csrPem } = await makeDeviceCert(intermediateA, dbWrongToken.device!.username);
    try {
      await enrollDevice({ username: dbWrongToken.device!.username, token: 'el-incorrecto', csrBody: csrPem });
      assert.fail('deberia haber rechazado');
    } catch (err) {
      wrongTokenError = err as EstRejection;
    }
  } finally {
    mock.restoreAll();
  }

  assert.equal(unknownDeviceError!.apiError.status, wrongTokenError!.apiError.status);
  assert.equal(unknownDeviceError!.apiError.message, wrongTokenError!.apiError.message);
  // ... pero el motivo real que se audita si es distinto.
  assert.equal(unknownDeviceError!.reason, 'dispositivo_no_encontrado');
  assert.equal(wrongTokenError!.reason, 'token_invalido');
});

test('enrollDevice: rechaza un CSR con firma invalida sin gastar el token', async () => {
  const db = makeFakeDb();
  addToken(db, 'sin-gastar');
  installFakeDb(db);
  try {
    const { csrPem } = await makeDeviceCert(intermediateA, db.device!.username);
    // Corrompe el ultimo byte del CSR en DER (parte de la firma, el ultimo
    // campo de CertificationRequest): sigue siendo un PKCS10 valido en
    // cuanto a formato, pero la firma ya no verifica.
    const der = Buffer.from(Buffer.from(csrPem.replace(/-----[^-]+-----|\s/g, ''), 'base64'));
    der[der.length - 1] = der[der.length - 1]! ^ 0xff;

    await assert.rejects(
      enrollDevice({ username: db.device!.username, token: 'sin-gastar', csrBody: der.toString('base64') }),
      /firma del CSR/,
    );

    // El token sigue sin usar: se puede reintentar con un CSR valido.
    const { csrPem: goodCsr } = await makeDeviceCert(intermediateA, db.device!.username);
    const result = await enrollDevice({ username: db.device!.username, token: 'sin-gastar', csrBody: goodCsr });
    assert.match(result.serial, /^[0-9a-f]{32}$/);
  } finally {
    mock.restoreAll();
  }
});

test('enrollDevice: si falla la firma tras reclamar el token (sin CA activa), lo libera para poder reintentar', async () => {
  const db = makeFakeDb({ activeCaId: null });
  addToken(db, 'reintentable');
  installFakeDb(db);
  try {
    const { csrPem } = await makeDeviceCert(intermediateA, db.device!.username);
    await assert.rejects(
      enrollDevice({ username: db.device!.username, token: 'reintentable', csrBody: csrPem }),
      /CA intermedia activa/,
    );

    // El token sigue disponible: se puede reclamar otra vez sin generar uno nuevo.
    const claimedAgain = await claimEnrollToken(db.device!.username, 'reintentable');
    assert.equal(claimedAgain, true);
  } finally {
    mock.restoreAll();
  }
});

test('claimEnrollToken: no se puede reclamar dos veces el mismo token (concurrencia)', async () => {
  const db = makeFakeDb();
  addToken(db, 'una-vez');
  installFakeDb(db);
  try {
    const [first, second] = await Promise.all([
      claimEnrollToken(db.device!.username, 'una-vez'),
      claimEnrollToken(db.device!.username, 'una-vez'),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
  } finally {
    mock.restoreAll();
  }
});

/* --------------------------------- simplereenroll --------------------------------- */

test('renewDevice: renovacion correcta, con solapamiento', async () => {
  const db = makeFakeDb();
  const old = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, old.cert);
  installFakeDb(db);
  try {
    const fresh = await makeDeviceCert(intermediateA, db.device!.username);
    const result = await renewDevice({ clientCertDer: old.cert.rawData, csrBody: fresh.csrPem });

    const oldRow = db.certificates.get(old.cert.serialNumber.toLowerCase());
    assert.equal(oldRow?.status, 'superseded');
    assert.ok(oldRow?.superseded_until);
    // superseded_until se guarda como "YYYY-MM-DD HH:MM:SS" en UTC (sin sufijo Z):
    // Date.parse lo trataria como hora local sin este ajuste.
    const overlapMs = Date.parse(`${oldRow!.superseded_until!.replace(' ', 'T')}Z`) - Date.now();
    assert.ok(overlapMs > 47 * HOUR && overlapMs < 49 * HOUR); // overlap_hours = 48 en defaultSettingsRow

    const newRow = db.certificates.get(result.serial);
    assert.equal(newRow?.status, 'active');
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza un certificado revocado', async () => {
  const db = makeFakeDb();
  const c = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, c.cert, { status: 'revoked', revoked_at: toSqlDateTime(new Date()) });
  installFakeDb(db);
  try {
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: c.csrPem }),
      /revocado/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza un certificado caducado', async () => {
  const db = makeFakeDb();
  const c = await makeDeviceCert(intermediateA, db.device!.username, {
    notBefore: new Date(Date.now() - 60 * DAY),
    notAfter: new Date(Date.now() - 1 * DAY),
  });
  addCertificate(db, c.cert);
  installFakeDb(db);
  try {
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: c.csrPem }),
      /caducado/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza un certificado ya superseded (no esta activo)', async () => {
  const db = makeFakeDb();
  const c = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, c.cert, {
    status: 'superseded',
    superseded_until: toSqlDateTime(new Date(Date.now() + DAY)),
  });
  installFakeDb(db);
  try {
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: c.csrPem }),
      /no esta activo/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza un certificado firmado por otra CA (ca_id no coincide con el firmante real)', async () => {
  const db = makeFakeDb();
  // Firmado de verdad por intermediateB, pero la fila dice que lo emitio CA_A.
  const c = await makeDeviceCert(intermediateB, db.device!.username);
  addCertificate(db, c.cert, { ca_id: CA_A_ID });
  installFakeDb(db);
  try {
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: c.csrPem }),
      /cadena de confianza/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza sin certificado de cliente (serial desconocido)', async () => {
  const db = makeFakeDb();
  installFakeDb(db);
  try {
    const foreign = await makeDeviceCert(intermediateA, 'vpn-nadie-nada'); // nunca registrado en vpn_certificates
    await assert.rejects(
      renewDevice({ clientCertDer: foreign.cert.rawData, csrBody: foreign.csrPem }),
      /no reconocido/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza si el CN del CSR no coincide con el certificado presentado', async () => {
  const db = makeFakeDb();
  const c = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, c.cert);
  installFakeDb(db);
  try {
    const otroCsr = await makeDeviceCert(intermediateA, 'vpn-otro-nombre');
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: otroCsr.csrPem }),
      /CN del CSR/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza si la clave del CSR ya se uso antes para ese dispositivo', async () => {
  const db = makeFakeDb();
  const c = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, c.cert);
  installFakeDb(db);
  try {
    // CSR con la clave del certificado VIEJO en vez de una nueva.
    const reusedCsr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: `CN=${db.device!.username}`,
      keys: c.keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    });
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: reusedCsr.toString() }),
      /clave del CSR ya se ha usado/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza si se renueva antes de tiempo (limite de frecuencia)', async () => {
  const db = makeFakeDb();
  const c = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, c.cert, { created_at: toSqlDateTime(new Date(Date.now() - 1 * HOUR)) });
  installFakeDb(db);
  try {
    const fresh = await makeDeviceCert(intermediateA, db.device!.username);
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: fresh.csrPem }),
      new RegExp(`cada ${RENEW_MIN_INTERVAL_HOURS}h`),
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza si el dispositivo esta deshabilitado', async () => {
  const db = makeFakeDb({ device: { username: 'vpn-juan-laptop', platform: 'linux', cert_days: null, renew_after_days: null, enabled: 0 } });
  const c = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, c.cert);
  installFakeDb(db);
  try {
    const fresh = await makeDeviceCert(intermediateA, db.device!.username);
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: fresh.csrPem }),
      /Dispositivo deshabilitado/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: rechaza si el CN del certificado presentado no coincide con el username de su fila', async () => {
  const db = makeFakeDb();
  const c = await makeDeviceCert(intermediateA, db.device!.username); // CN real = vpn-juan-laptop
  // La fila en vpn_certificates dice que es de OTRO dispositivo (dato
  // heredado, error de correlacion...): mismo serial, mismo emisor, pero
  // username distinto del CN que lleva el certificado de verdad.
  addCertificate(db, c.cert, { username: 'vpn-otro-dispositivo' });
  installFakeDb(db);
  try {
    const fresh = await makeDeviceCert(intermediateA, db.device!.username);
    await assert.rejects(
      renewDevice({ clientCertDer: c.cert.rawData, csrBody: fresh.csrPem }),
      /CN del certificado presentado/,
    );
  } finally {
    mock.restoreAll();
  }
});

test('renewDevice: dos renovaciones concurrentes del mismo dispositivo, solo una tiene exito', async () => {
  const db = makeFakeDb();
  const old = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, old.cert);
  installFakeDb(db);
  try {
    const csrA = await makeDeviceCert(intermediateA, db.device!.username);
    const csrB = await makeDeviceCert(intermediateA, db.device!.username);

    const results = await Promise.allSettled([
      renewDevice({ clientCertDer: old.cert.rawData, csrBody: csrA.csrPem }),
      renewDevice({ clientCertDer: old.cert.rawData, csrBody: csrB.csrPem }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    // La perdedora bloquea hasta que la ganadora confirma y entonces ve el
    // certificado presentado ya 'superseded' -- no un fallo de otro tipo
    // (p.ej. clave reutilizada), lo que demostraria que no se bloqueo.
    assert.match(String((rejected[0]!.reason as Error).message), /no esta activo/);

    assert.equal([...db.certificates.values()].filter((c) => c.status === 'active').length, 1);
  } finally {
    mock.restoreAll();
  }
});

/* ------------------------------------ status ------------------------------------ */

test('getStatus: informa de la caducidad y si toca renovar', async () => {
  const db = makeFakeDb();
  const c = await makeDeviceCert(intermediateA, db.device!.username, {
    notBefore: new Date(Date.now() - 25 * DAY),
    notAfter: new Date(Date.now() + 5 * DAY),
  });
  addCertificate(db, c.cert, { not_before: toSqlDateTime(c.cert.notBefore) });
  installFakeDb(db);
  try {
    const status = await getStatus(c.cert.rawData);
    assert.equal(status.username, db.device!.username);
    assert.equal(status.renewDue, true); // renew_after_days=20 y ya han pasado 25
    // ISO 8601 UTC, no el "YYYY-MM-DD HH:MM:SS" de MariaDB (rompia el parseo en .NET)
    assert.match(status.notAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(status.notAfter, c.cert.notAfter.toISOString().replace(/\.\d{3}Z$/, '.000Z'));
    assert.equal(status.minAppVersion, '1.4.0'); // para que la app bloquee alta/renovacion si va por debajo
  } finally {
    mock.restoreAll();
  }
});

test('getStatus: rechaza un certificado autofirmado con el serial de uno valido', async () => {
  const db = makeFakeDb();
  const real = await makeDeviceCert(intermediateA, db.device!.username);
  addCertificate(db, real.cert);
  installFakeDb(db);
  try {
    // Mismo serial que el legitimo, pero AUTOFIRMADO (no por intermediateA):
    // si /status no comprobara la cadena (solo el estado 'active' de la
    // fila, como antes de esta correccion) pasaria igual.
    const forgedKeys = await generateEcKeyPair('P-256');
    const forged = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: real.cert.serialNumber,
      name: `CN=${db.device!.username}`,
      keys: forgedKeys,
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + 30 * DAY),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    });
    await assert.rejects(getStatus(forged.rawData), /cadena de confianza/);
  } finally {
    mock.restoreAll();
  }
});

test('toIsoUtc: convierte el DATETIME de MariaDB (UTC, sin zona) a ISO 8601', () => {
  assert.equal(toIsoUtc('2026-10-31 10:03:43'), '2026-10-31T10:03:43.000Z');
  assert.equal(toIsoUtc('2026-10-31T10:03:43Z'), '2026-10-31T10:03:43.000Z');
  assert.equal(toIsoUtc(new Date('2026-10-31T10:03:43Z')), '2026-10-31T10:03:43.000Z');
  assert.throws(() => toIsoUtc('no es una fecha'));
});
