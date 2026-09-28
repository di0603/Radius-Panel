import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool, radiusPool } from '../db/pools.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { decryptPkiPrivateKey, encryptPkiPrivateKey } from '../lib/pkiCrypto.js';
import {
  RSA_SIGNING_ALGORITHM,
  exportPrivateKeyPem,
  generateRsaKeyPair,
  importRsaPrivateKeyPem,
  sha256Hex,
  x509,
} from '../lib/x509.js';

/**
 * Gestion de la CA intermedia de la VPN: generar CSR, importar el
 * certificado firmado por la raiz offline, rotacion y publicacion de CRL.
 * Ver sql/panel-schema-vpn-pki.sql para el esquema de panel_pki_ca.
 */

export type PkiCaRole = 'root' | 'intermediate';
export type PkiCaStatus = 'pending' | 'active' | 'retiring' | 'retired';

export interface PkiCaSummary {
  id: number;
  role: PkiCaRole;
  status: PkiCaStatus;
  subjectCn: string | null;
  serial: string | null;
  spkiSha256: string | null;
  notBefore: string | null;
  notAfter: string | null;
  crlNumber: number;
  crlLastGeneratedAt: string | null;
  crlNextUpdate: string | null;
  createdAt: string;
  importedAt: string | null;
}

export interface PkiStatus {
  root: PkiCaSummary | null;
  intermediates: PkiCaSummary[];
  activeDeviceCertificates: number;
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

function toSummary(row: RowDataPacket): PkiCaSummary {
  return {
    id: Number(row.id),
    role: row.role,
    status: row.status,
    subjectCn: row.subject_cn ?? null,
    serial: row.serial ?? null,
    spkiSha256: row.spki_sha256 ?? null,
    notBefore: row.not_before ?? null,
    notAfter: row.not_after ?? null,
    crlNumber: Number(row.crl_number ?? 0),
    crlLastGeneratedAt: row.crl_last_generated_at ?? null,
    crlNextUpdate: row.crl_next_update ?? null,
    createdAt: row.created_at,
    importedAt: row.imported_at ?? null,
  };
}

/** Vista general para la pagina "PKI": CA raiz, intermedias y sus CRL. */
export async function getPkiStatus(): Promise<PkiStatus> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT * FROM panel_pki_ca ORDER BY role ASC, created_at DESC`,
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return { root: null, intermediates: [], activeDeviceCertificates: 0 };
  }

  const rootRow = rows.find((r) => r.role === 'root');
  const intermediateRows = rows.filter((r) => r.role === 'intermediate');

  let activeDeviceCertificates = 0;
  try {
    const [[count]] = await radiusPool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM vpn_certificates WHERE status = 'active'`,
    );
    activeDeviceCertificates = Number(count?.n ?? 0);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }

  return {
    root: rootRow ? toSummary(rootRow) : null,
    intermediates: intermediateRows.map(toSummary),
    activeDeviceCertificates,
  };
}

async function getStoredRoot(): Promise<RowDataPacket | undefined> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT * FROM panel_pki_ca WHERE role = 'root' LIMIT 1`,
  );
  return row;
}

/**
 * Paso 1 del alta de la CA intermedia: genera un par de claves RSA y su CSR.
 * La clave privada se cifra con PKI_MASTER_KEY antes de guardarla; nunca se
 * devuelve ni se audita en claro. Solo puede haber una intermedia pendiente
 * de importar a la vez.
 */
export async function generateIntermediateCsr(input: {
  subjectCn: string;
  createdBy: number | null;
}): Promise<{ id: number; csrPem: string; subjectCn: string }> {
  const [[existingPending]] = await panelPool.query<RowDataPacket[]>(
    `SELECT id FROM panel_pki_ca WHERE role = 'intermediate' AND status = 'pending' LIMIT 1`,
  );
  if (existingPending) {
    throw conflict(
      'Ya hay una CA intermedia pendiente de importar. Impórtala o cancélala antes de generar otra.',
    );
  }

  const keys = await generateRsaKeyPair();
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${input.subjectCn}`,
    keys,
    signingAlgorithm: RSA_SIGNING_ALGORITHM,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const csrPem = csr.toString();
  const privateKeyPem = await exportPrivateKeyPem(keys.privateKey);
  const spkiSha256 = sha256Hex(csr.publicKey.rawData);
  const privateKeyEncrypted = encryptPkiPrivateKey(privateKeyPem);

  const [result] = await panelPool.query<ResultSetHeader>(
    `INSERT INTO panel_pki_ca
       (role, status, subject_cn, private_key_encrypted, csr_pem, spki_sha256, key_created_at, created_by)
     VALUES ('intermediate', 'pending', :subjectCn, :privateKeyEncrypted, :csrPem, :spkiSha256, NOW(), :createdBy)`,
    {
      subjectCn: input.subjectCn,
      privateKeyEncrypted,
      csrPem,
      spkiSha256,
      createdBy: input.createdBy,
    },
  );

  return { id: result.insertId, csrPem, subjectCn: input.subjectCn };
}

/** Cancela una CA intermedia pendiente (todavia sin certificado importado). */
export async function cancelPendingIntermediate(id: number): Promise<void> {
  const [result] = await panelPool.query<ResultSetHeader>(
    `DELETE FROM panel_pki_ca WHERE id = :id AND role = 'intermediate' AND status = 'pending'`,
    { id },
  );
  if (result.affectedRows === 0) {
    throw notFound('No existe una CA intermedia pendiente con ese id');
  }
}

/**
 * Comprueba que `intermediateCert` es una intermedia valida emitida por
 * `rootCert` y que corresponde a la clave privada generada por el panel
 * (`expectedSpkiSha256`). No toca la base de datos: es pura para poder
 * probarla sin depender de MySQL. Lanza ApiError(400) con un mensaje
 * especifico si algo no cuadra.
 */
export async function validateIntermediateImport(input: {
  intermediateCert: x509.X509Certificate;
  rootCert: x509.X509Certificate;
  expectedSpkiSha256: string;
  now?: Date;
}): Promise<void> {
  const { intermediateCert, rootCert, expectedSpkiSha256, now = new Date() } = input;

  const rootBasicConstraints = rootCert.getExtension(x509.BasicConstraintsExtension);
  if (!rootBasicConstraints?.ca) {
    throw badRequest('El certificado de la CA raiz no tiene BasicConstraints CA:true');
  }

  // Las comprobaciones de fecha van antes que `verify()`: @peculiar/x509 valida la
  // fecha como parte de la firma (por defecto contra "ahora") y, si el certificado
  // ya no esta vigente, devuelve false igual que si la firma fuera invalida — sin
  // este orden, un certificado caducado saldria con el mensaje de firma incorrecta
  // en vez de uno que explique que el problema es la vigencia.
  if (now < intermediateCert.notBefore || now > intermediateCert.notAfter) {
    throw badRequest('El certificado no esta vigente (caducado o con fecha de inicio futura)');
  }

  if (intermediateCert.notAfter > rootCert.notAfter) {
    throw badRequest('El certificado intermedio caduca despues que la CA raiz');
  }

  if (intermediateCert.issuer !== rootCert.subject) {
    throw badRequest('El emisor del certificado no coincide con el sujeto de la CA raiz');
  }

  const signedByRoot = await intermediateCert.verify({ publicKey: rootCert.publicKey });
  if (!signedByRoot) {
    throw badRequest('El certificado no esta firmado por la CA raiz proporcionada');
  }

  const basicConstraints = intermediateCert.getExtension(x509.BasicConstraintsExtension);
  if (!basicConstraints?.ca) {
    throw badRequest(
      'El certificado no tiene BasicConstraints CA:true: no es un certificado de CA',
    );
  }

  const keyUsage = intermediateCert.getExtension(x509.KeyUsagesExtension);
  const needed = x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign;
  if (((keyUsage?.usages ?? 0) & needed) !== needed) {
    throw badRequest('El certificado no tiene KeyUsage keyCertSign + cRLSign');
  }

  const spkiSha256 = sha256Hex(intermediateCert.publicKey.rawData);
  if (spkiSha256 !== expectedSpkiSha256) {
    throw badRequest(
      'El certificado subido no corresponde a la clave privada generada por el panel para este CSR',
    );
  }
}

/**
 * Paso 2 del alta: importa el certificado de la intermedia firmado offline
 * (y el de la raiz, la primera vez). Si ya hay una intermedia activa, esta
 * pasa a "retiring" (sigue publicando CRL hasta que caduque, pero deja de
 * firmar certificados nuevos).
 */
export async function importIntermediate(
  id: number,
  input: { certPem: string; rootCertPem: string },
): Promise<PkiCaSummary> {
  const [[pending]] = await panelPool.query<RowDataPacket[]>(
    `SELECT * FROM panel_pki_ca WHERE id = :id AND role = 'intermediate' AND status = 'pending' LIMIT 1`,
    { id },
  );
  if (!pending) throw notFound('No existe una CA intermedia pendiente con ese id');
  if (!pending.spki_sha256) {
    throw new Error(
      `panel_pki_ca id=${id}: falta spki_sha256 en una fila pendiente (dato inconsistente)`,
    );
  }

  let intermediateCert: x509.X509Certificate;
  let rootCert: x509.X509Certificate;
  try {
    intermediateCert = new x509.X509Certificate(input.certPem);
    rootCert = new x509.X509Certificate(input.rootCertPem);
  } catch {
    throw badRequest('No se ha podido leer alguno de los certificados (PEM invalido)');
  }

  const rootSerial = rootCert.serialNumber.toLowerCase();
  const existingRoot = await getStoredRoot();
  if (existingRoot?.serial && existingRoot.serial !== rootSerial) {
    throw conflict(
      'Ya hay una CA raiz distinta registrada en el panel; usar varias raices no esta soportado',
    );
  }

  await validateIntermediateImport({
    intermediateCert,
    rootCert,
    expectedSpkiSha256: pending.spki_sha256,
  });

  const conn = await panelPool.getConnection();
  try {
    await conn.beginTransaction();

    if (!existingRoot) {
      await conn.query(
        `INSERT INTO panel_pki_ca (role, status, subject_cn, serial, not_before, not_after, cert_pem, imported_at)
         VALUES ('root', 'active', :subjectCn, :serial, :notBefore, :notAfter, :certPem, NOW())`,
        {
          subjectCn: rootCert.subject,
          serial: rootSerial,
          notBefore: rootCert.notBefore,
          notAfter: rootCert.notAfter,
          certPem: rootCert.toString(),
        },
      );
    }

    await conn.query(
      `UPDATE panel_pki_ca SET status = 'retiring' WHERE role = 'intermediate' AND status = 'active' AND id != :id`,
      { id },
    );

    await conn.query(
      `UPDATE panel_pki_ca
          SET status = 'active', subject_cn = :subjectCn, serial = :serial, not_before = :notBefore,
              not_after = :notAfter, cert_pem = :certPem, issuer_serial = :issuerSerial, imported_at = NOW()
        WHERE id = :id`,
      {
        id,
        subjectCn: intermediateCert.subject,
        serial: intermediateCert.serialNumber.toLowerCase(),
        notBefore: intermediateCert.notBefore,
        notAfter: intermediateCert.notAfter,
        certPem: intermediateCert.toString(),
        issuerSerial: rootSerial,
      },
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await regenerateCrl(id);

  const [[updated]] = await panelPool.query<RowDataPacket[]>(
    `SELECT * FROM panel_pki_ca WHERE id = :id`,
    { id },
  );
  return toSummary(updated);
}

export interface CrlEntryInput {
  serialNumber: string;
  revocationDate: Date;
  reason?: x509.X509CrlReason;
}

/**
 * Construye y firma una CRL. Pura (no toca la base de datos): recibe el
 * certificado y la clave de firma ya cargados, para poder probarla sin
 * depender de MySQL ni de PKI_MASTER_KEY.
 */
export async function buildCrl(input: {
  issuerCert: x509.X509Certificate;
  signingKey: CryptoKey;
  entries: CrlEntryInput[];
  thisUpdate?: Date;
  nextUpdateDays?: number;
}): Promise<x509.X509Crl> {
  const { issuerCert, signingKey, entries, thisUpdate = new Date(), nextUpdateDays = 7 } = input;
  const nextUpdate = new Date(thisUpdate.getTime() + nextUpdateDays * 24 * 60 * 60 * 1000);
  const authorityKeyId = await x509.AuthorityKeyIdentifierExtension.create(issuerCert.publicKey);

  return x509.X509CrlGenerator.create({
    issuer: issuerCert.subject,
    thisUpdate,
    nextUpdate,
    signingAlgorithm: RSA_SIGNING_ALGORITHM,
    signingKey,
    entries: entries.map((e) => ({
      serialNumber: e.serialNumber,
      revocationDate: e.revocationDate,
      reason: e.reason,
    })),
    extensions: [authorityKeyId],
  });
}

/**
 * `vpn_certificates.ca_serial` (sql/radius-schema-vpn-issuer.sql) enlaza cada
 * certificado con el serial de la CA que lo firmo. Sigue vacio para los
 * certificados sin CA gestionada (p.ej. el dispositivo de prueba "vps",
 * firmado directamente por la raiz): esos nunca aparecen en ninguna CRL
 * automatica. Se degrada a "sin revocados" si la columna todavia no existe
 * (migracion no aplicada) o si `caSerial` es null.
 */
async function getRevokedEntriesForCa(caSerial: string | null): Promise<CrlEntryInput[]> {
  if (!caSerial) return [];
  try {
    const [rows] = await radiusPool.query<RowDataPacket[]>(
      `SELECT serial, revoked_at FROM vpn_certificates WHERE ca_serial = :caSerial AND status = 'revoked'`,
      { caSerial },
    );
    return rows.map((r) => ({
      serialNumber: String(r.serial),
      revocationDate: new Date(String(r.revoked_at).replace(' ', 'T') + 'Z'),
    }));
  } catch (err) {
    if ((err as { code?: string } | undefined)?.code === 'ER_BAD_FIELD_ERROR') return [];
    throw err;
  }
}

/**
 * Regenera la CRL de la CA cuyo serial firmo un certificado dado, tras
 * revocarlo. No-op silencioso si ese serial no corresponde a ninguna CA
 * gestionada por el panel (ver `getRevokedEntriesForCa`) o si ya no esta
 * activa/retirandose.
 */
export async function regenerateCrlBySerial(caSerial: string): Promise<void> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT id FROM panel_pki_ca WHERE role = 'intermediate' AND serial = :serial
       AND status IN ('active', 'retiring') LIMIT 1`,
    { serial: caSerial },
  );
  if (row) await regenerateCrl(Number(row.id));
}

/** Regenera y guarda la CRL de una CA intermedia activa o en retirada. */
export async function regenerateCrl(caId: number): Promise<string> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT * FROM panel_pki_ca WHERE id = :id AND role = 'intermediate' LIMIT 1`,
    { id: caId },
  );
  if (!row || !row.cert_pem || !row.private_key_encrypted) {
    throw badRequest('Esta CA intermedia todavia no tiene un certificado importado');
  }
  if (row.status !== 'active' && row.status !== 'retiring') {
    throw badRequest('Solo se puede regenerar la CRL de una CA activa o en retirada');
  }

  const issuerCert = new x509.X509Certificate(row.cert_pem);
  const signingKey = await importRsaPrivateKeyPem(decryptPkiPrivateKey(row.private_key_encrypted));
  const entries = await getRevokedEntriesForCa(row.serial);

  const crl = await buildCrl({ issuerCert, signingKey, entries });
  const crlPem = crl.toString();

  await panelPool.query(
    `UPDATE panel_pki_ca
        SET crl_pem = :crlPem, crl_number = crl_number + 1, crl_last_generated_at = NOW(),
            crl_next_update = :nextUpdate
      WHERE id = :id`,
    { crlPem, nextUpdate: crl.nextUpdate, id: caId },
  );

  return crlPem;
}

/** Regenera la CRL de toda CA cuya proxima actualizacion vence en menos de un dia. Uso: tarea diaria. */
export async function regenerateDueCrls(): Promise<number> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT id FROM panel_pki_ca
        WHERE role = 'intermediate' AND status IN ('active', 'retiring')
          AND (crl_next_update IS NULL OR crl_next_update <= DATE_ADD(NOW(), INTERVAL 1 DAY))`,
    );
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
  for (const row of rows) await regenerateCrl(Number(row.id));
  return rows.length;
}

/**
 * GET /pki/ca-chain.pem: intermedia(s) vigentes + raiz, para que los
 * dispositivos validen el certificado del servidor RADIUS. `null` si la PKI
 * todavia no esta configurada.
 */
export async function getCaChainPem(): Promise<string | null> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT cert_pem, role FROM panel_pki_ca
        WHERE cert_pem IS NOT NULL AND (role = 'root' OR status IN ('active', 'retiring'))`,
    );
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  if (!rows.length) return null;
  const intermediates = rows.filter((r) => r.role === 'intermediate');
  const root = rows.filter((r) => r.role === 'root');
  return [...intermediates, ...root].map((r) => String(r.cert_pem).trim()).join('\n');
}

/** GET /pki/crl.pem: CRL vigente de cada intermedia activa o en retirada. `null` si no hay ninguna. */
export async function getCrlBundlePem(): Promise<string | null> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT crl_pem FROM panel_pki_ca
        WHERE role = 'intermediate' AND status IN ('active', 'retiring') AND crl_pem IS NOT NULL`,
    );
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  if (!rows.length) return null;
  return rows.map((r) => String(r.crl_pem).trim()).join('\n');
}
