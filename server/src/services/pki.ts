import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool, radiusPool } from '../db/pools.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { decryptPkiPrivateKey, encryptPkiPrivateKey } from '../lib/pkiCrypto.js';
import {
  EC_P384_SIGNING_ALGORITHM,
  exportPrivateKeyPem,
  generateEcKeyPair,
  importEcPrivateKeyPem,
  sha256Hex,
  x509,
} from '../lib/x509.js';

/**
 * Gestion de la CA intermedia de la VPN: generar CSR, importar el
 * certificado firmado por la raiz offline, rotacion y publicacion de CRL.
 * Ver sql/panel-schema-vpn.sql para el esquema de panel_pki_ca: una fila por
 * CA intermedia; la raiz (offline, el panel nunca tiene su clave privada) se
 * guarda como `root_cert_pem` dentro de esa misma fila, no como fila propia.
 */

export type PkiCaStatus = 'pending' | 'active' | 'retiring' | 'retired';

export interface PkiCaSummary {
  id: number;
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
  /** true si esta 'retired' sin haber llegado a activarse: una intermedia RSA de una version anterior. */
  staleAlgorithm: boolean;
}

export interface PkiRootSummary {
  subjectCn: string;
  serial: string;
  notAfter: string;
}

export interface PkiStatus {
  root: PkiRootSummary | null;
  intermediates: PkiCaSummary[];
  activeDeviceCertificates: number;
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

/** `crl_last_generated_at` no se guarda: se deriva de `crl_next_update - 7 dias` (ver buildCrl). */
function deriveCrlLastGeneratedAt(crlNextUpdate: string | null): string | null {
  if (!crlNextUpdate) return null;
  const next = new Date(`${String(crlNextUpdate).replace(' ', 'T')}Z`);
  return new Date(next.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

function toSummary(row: RowDataPacket): PkiCaSummary {
  return {
    id: Number(row.id),
    status: row.status,
    subjectCn: row.subject ?? null,
    serial: row.serial ?? null,
    spkiSha256: row.spki_sha256 ?? null,
    notBefore: row.not_before ?? null,
    notAfter: row.not_after ?? null,
    crlNumber: Number(row.crl_number ?? 0),
    crlLastGeneratedAt: deriveCrlLastGeneratedAt(row.crl_next_update ?? null),
    crlNextUpdate: row.crl_next_update ?? null,
    createdAt: row.created_at,
    staleAlgorithm: row.status === 'retired' && !row.cert_pem,
  };
}

async function getStoredRootCertPem(): Promise<string | null> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT root_cert_pem FROM panel_pki_ca WHERE root_cert_pem IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
  );
  return row?.root_cert_pem ?? null;
}

/** Vista general para la pagina "PKI": CA raiz, intermedias y sus CRL. */
export async function getPkiStatus(): Promise<PkiStatus> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT * FROM panel_pki_ca ORDER BY created_at DESC`,
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return { root: null, intermediates: [], activeDeviceCertificates: 0 };
  }

  let root: PkiRootSummary | null = null;
  const rootPem = rows.find((r) => r.root_cert_pem)?.root_cert_pem;
  if (rootPem) {
    const rootCert = new x509.X509Certificate(rootPem);
    root = {
      subjectCn: rootCert.subject,
      serial: rootCert.serialNumber.toLowerCase(),
      notAfter: rootCert.notAfter.toISOString(),
    };
  }

  let activeDeviceCertificates = 0;
  try {
    const [[count]] = await radiusPool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM vpn_certificates WHERE status = 'active'`,
    );
    activeDeviceCertificates = Number(count?.n ?? 0);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }

  return { root, intermediates: rows.map(toSummary), activeDeviceCertificates };
}

/**
 * Si al arrancar (o al consultar el estado) queda alguna intermedia
 * 'pending' generada con una version anterior del panel (RSA en vez de
 * ECDSA P-384), se retira: no se puede importar un certificado para una
 * clave con un algoritmo que ya no se admite. La pagina PKI lo muestra como
 * aviso (`PkiCaSummary.staleAlgorithm`) para que se genere una nueva.
 */
export async function retireStaleRsaIntermediates(): Promise<number> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT id, csr_pem FROM panel_pki_ca WHERE status = 'pending' AND csr_pem IS NOT NULL`,
    );
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }

  let retired = 0;
  for (const row of rows) {
    let isEcP384 = false;
    try {
      const csr = new x509.Pkcs10CertificateRequest(row.csr_pem);
      const alg = csr.publicKey.algorithm as { name: string; namedCurve?: string };
      isEcP384 = alg.name === 'ECDSA' && alg.namedCurve === 'P-384';
    } catch {
      isEcP384 = false; // CSR ilegible: se trata igual que un algoritmo no admitido.
    }
    if (!isEcP384) {
      await panelPool.query(`UPDATE panel_pki_ca SET status = 'retired' WHERE id = :id`, {
        id: row.id,
      });
      retired++;
    }
  }
  return retired;
}

/**
 * Paso 1 del alta de la CA intermedia: genera un par de claves ECDSA P-384 y
 * su CSR (BasicConstraints CA:true con pathLenConstraint=0, KeyUsage
 * keyCertSign+cRLSign, EKU solo clientAuth). La clave privada se cifra con
 * PKI_MASTER_KEY antes de guardarla; nunca se devuelve ni se audita en
 * claro. Solo puede haber una intermedia pendiente de importar a la vez.
 */
export async function generateIntermediateCsr(input: {
  subjectCn: string;
  createdBy: number | null;
}): Promise<{ id: number; csrPem: string; subjectCn: string }> {
  const [[existingPending]] = await panelPool.query<RowDataPacket[]>(
    `SELECT id FROM panel_pki_ca WHERE status = 'pending' LIMIT 1`,
  );
  if (existingPending) {
    throw conflict(
      'Ya hay una CA intermedia pendiente de importar. Impórtala o cancélala antes de generar otra.',
    );
  }

  const keys = await generateEcKeyPair('P-384');
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${input.subjectCn}`,
    keys,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
    ],
  });
  const csrPem = csr.toString();
  const privateKeyPem = await exportPrivateKeyPem(keys.privateKey);
  const spkiSha256 = sha256Hex(csr.publicKey.rawData);
  const privateKeyEncrypted = encryptPkiPrivateKey(privateKeyPem);

  const [result] = await panelPool.query<ResultSetHeader>(
    `INSERT INTO panel_pki_ca (status, subject, private_key_encrypted, csr_pem, spki_sha256)
     VALUES ('pending', :subjectCn, :privateKeyEncrypted, :csrPem, :spkiSha256)`,
    { subjectCn: input.subjectCn, privateKeyEncrypted, csrPem, spkiSha256 },
  );

  return { id: result.insertId, csrPem, subjectCn: input.subjectCn };
}

/** Cancela una CA intermedia pendiente (todavia sin certificado importado). */
export async function cancelPendingIntermediate(id: number): Promise<void> {
  const [result] = await panelPool.query<ResultSetHeader>(
    `DELETE FROM panel_pki_ca WHERE id = :id AND status = 'pending'`,
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
  if (basicConstraints.pathLength !== 0) {
    throw badRequest('El certificado debe tener BasicConstraints con pathLenConstraint = 0');
  }

  const keyUsage = intermediateCert.getExtension(x509.KeyUsagesExtension);
  const needed = x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign;
  if (((keyUsage?.usages ?? 0) & needed) !== needed) {
    throw badRequest('El certificado no tiene KeyUsage keyCertSign + cRLSign');
  }

  const eku = intermediateCert.getExtension(x509.ExtendedKeyUsageExtension);
  if (!eku || eku.usages.length === 0) {
    throw badRequest('El certificado no tiene ExtendedKeyUsage');
  }
  if (eku.usages.some((u) => u !== x509.ExtendedKeyUsage.clientAuth)) {
    throw badRequest('El ExtendedKeyUsage del certificado debe ser unicamente clientAuth');
  }

  const alg = intermediateCert.publicKey.algorithm as { name?: string; namedCurve?: string };
  if (alg.name !== 'ECDSA' || alg.namedCurve !== 'P-384') {
    throw badRequest('La clave del certificado debe ser ECDSA P-384');
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
 * (y el de la raiz). Si ya hay una intermedia activa, esta pasa a
 * "retiring" (sigue publicando CRL hasta que caduque, pero deja de firmar
 * certificados nuevos).
 */
export async function importIntermediate(
  id: number,
  input: { certPem: string; rootCertPem: string },
): Promise<PkiCaSummary> {
  const [[pending]] = await panelPool.query<RowDataPacket[]>(
    `SELECT * FROM panel_pki_ca WHERE id = :id AND status = 'pending' LIMIT 1`,
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

  const existingRootPem = await getStoredRootCertPem();
  if (existingRootPem) {
    const existingRootSerial = new x509.X509Certificate(existingRootPem).serialNumber.toLowerCase();
    if (existingRootSerial !== rootCert.serialNumber.toLowerCase()) {
      throw conflict(
        'Ya hay una CA raiz distinta registrada en el panel; usar varias raices no esta soportado',
      );
    }
  }

  await validateIntermediateImport({
    intermediateCert,
    rootCert,
    expectedSpkiSha256: pending.spki_sha256,
  });

  const conn = await panelPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE panel_pki_ca SET status = 'retiring' WHERE status = 'active' AND id != :id`,
      {
        id,
      },
    );
    await conn.query(
      `UPDATE panel_pki_ca
          SET status = 'active', subject = :subject, serial = :serial, not_before = :notBefore,
              not_after = :notAfter, cert_pem = :certPem, root_cert_pem = :rootCertPem
        WHERE id = :id`,
      {
        id,
        subject: intermediateCert.subject,
        serial: intermediateCert.serialNumber.toLowerCase(),
        notBefore: intermediateCert.notBefore,
        notAfter: intermediateCert.notAfter,
        certPem: intermediateCert.toString(),
        rootCertPem: rootCert.toString(),
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
    {
      id,
    },
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
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    signingKey,
    entries: entries.map((e) => ({
      serialNumber: e.serialNumber,
      revocationDate: e.revocationDate,
      reason: e.reason,
    })),
    extensions: [authorityKeyId],
  });
}

export interface CaSigningMaterial {
  id: number;
  cert: x509.X509Certificate;
  signingKey: CryptoKey;
}

async function loadSigningMaterial(row: RowDataPacket): Promise<CaSigningMaterial> {
  if (!row.cert_pem || !row.private_key_encrypted) {
    throw badRequest('Esta CA intermedia todavia no tiene un certificado importado');
  }
  return {
    id: Number(row.id),
    cert: new x509.X509Certificate(row.cert_pem),
    signingKey: await importEcPrivateKeyPem(decryptPkiPrivateKey(row.private_key_encrypted), 'P-384'),
  };
}

/**
 * La CA intermedia que firma los certificados de dispositivo nuevos (EST
 * simpleenroll/simplereenroll). Solo puede haber una 'active' a la vez.
 */
export async function getActiveIntermediate(): Promise<CaSigningMaterial> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT * FROM panel_pki_ca WHERE status = 'active' LIMIT 1`,
  );
  if (!row) {
    throw conflict('No hay ninguna CA intermedia activa: genera e importa una desde la pagina PKI');
  }
  return loadSigningMaterial(row);
}

/** Certificado (sin la clave privada) de una CA por su id. `null` si no existe o no tiene cert_pem. */
export async function getCaCertById(caId: number): Promise<x509.X509Certificate | null> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT cert_pem FROM panel_pki_ca WHERE id = :id`,
    { id: caId },
  );
  if (!row?.cert_pem) return null;
  return new x509.X509Certificate(row.cert_pem);
}

/**
 * `vpn_certificates.ca_id` (sql/radius-schema-vpn-issuer.sql) enlaza cada
 * certificado con el id de `panel_pki_ca` que lo firmo. Sigue vacio para los
 * certificados sin CA gestionada (p.ej. el dispositivo de prueba "vps",
 * firmado directamente por la raiz): esos nunca aparecen en ninguna CRL
 * automatica. Se degrada a "sin revocados" si la columna todavia no existe.
 *
 * Excluye los que ya han caducado por si solos (`not_after` pasado): un
 * certificado caducado se rechaza igualmente aunque no apareciera en la CRL
 * (RFC 5280), asi que mantenerlo aqui para siempre solo hincha el fichero
 * sin anadir proteccion real. `npm run vpn:jobs` fuerza una regeneracion en
 * cuanto un revocado cruza su fecha de caducidad, para que no tarde hasta el
 * siguiente ciclo normal de la CRL en desaparecer.
 */
async function getRevokedEntriesForCa(caId: number): Promise<CrlEntryInput[]> {
  try {
    const [rows] = await radiusPool.query<RowDataPacket[]>(
      `SELECT serial, revoked_at FROM vpn_certificates
        WHERE ca_id = :caId AND status = 'revoked' AND not_after > UTC_TIMESTAMP()`,
      { caId },
    );
    return rows.map((r) => ({
      serialNumber: String(r.serial),
      revocationDate: new Date(`${String(r.revoked_at).replace(' ', 'T')}Z`),
    }));
  } catch (err) {
    if ((err as { code?: string } | undefined)?.code === 'ER_BAD_FIELD_ERROR') return [];
    throw err;
  }
}

/** Regenera y guarda la CRL de una CA intermedia activa o en retirada. */
export async function regenerateCrl(caId: number): Promise<string> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT * FROM panel_pki_ca WHERE id = :id`,
    {
      id: caId,
    },
  );
  if (!row || !row.cert_pem || !row.private_key_encrypted) {
    throw badRequest('Esta CA intermedia todavia no tiene un certificado importado');
  }
  if (row.status !== 'active' && row.status !== 'retiring') {
    throw badRequest('Solo se puede regenerar la CRL de una CA activa o en retirada');
  }

  const issuerCert = new x509.X509Certificate(row.cert_pem);
  const signingKey = await importEcPrivateKeyPem(
    decryptPkiPrivateKey(row.private_key_encrypted),
    'P-384',
  );
  const entries = await getRevokedEntriesForCa(caId);

  const crl = await buildCrl({ issuerCert, signingKey, entries });
  const crlPem = crl.toString();

  await panelPool.query(
    `UPDATE panel_pki_ca SET crl_pem = :crlPem, crl_number = crl_number + 1, crl_next_update = :nextUpdate
      WHERE id = :id`,
    { crlPem, nextUpdate: crl.nextUpdate, id: caId },
  );

  return crlPem;
}

/**
 * Regenera la CRL de toda CA cuya proxima actualizacion vence en menos de
 * `withinDays`. La llama tanto el timer de respaldo de server/src/index.ts
 * (por si `npm run vpn:jobs` no llega a desplegarse) como el propio
 * `vpn:jobs` (con un margen mas amplio y mucha mas frecuencia).
 */
export async function regenerateDueCrls(withinDays = 1): Promise<number> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT id FROM panel_pki_ca
        WHERE status IN ('active', 'retiring')
          AND (crl_next_update IS NULL OR crl_next_update <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL :withinDays DAY))`,
      { withinDays },
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
      `SELECT cert_pem, root_cert_pem FROM panel_pki_ca WHERE status IN ('active', 'retiring') AND cert_pem IS NOT NULL`,
    );
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  if (!rows.length) return null;
  const parts = rows.map((r) => String(r.cert_pem).trim());
  const rootPem = rows.find((r) => r.root_cert_pem)?.root_cert_pem;
  if (rootPem) parts.push(String(rootPem).trim());
  return parts.join('\n');
}

/**
 * La raiz offline (autofirmada), para el perfil .sswan de Android: ese
 * formato solo admite un unico certificado de confianza (`remote.cert`), y
 * el servidor IKE ya envia la intermedia dentro del propio handshake, asi
 * que a los clientes les basta con confiar en la raiz. `null` si la PKI
 * todavia no esta configurada.
 */
export async function getRootCaCert(): Promise<x509.X509Certificate | null> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT root_cert_pem FROM panel_pki_ca WHERE status IN ('active', 'retiring') AND root_cert_pem IS NOT NULL LIMIT 1`,
    );
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  if (!rows.length) return null;
  return new x509.X509Certificate(String(rows[0].root_cert_pem).trim());
}

/** GET /pki/crl.pem: CRL vigente de cada intermedia activa o en retirada. `null` si no hay ninguna. */
export async function getCrlBundlePem(): Promise<string | null> {
  let rows: RowDataPacket[] = [];
  try {
    [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT crl_pem FROM panel_pki_ca WHERE status IN ('active', 'retiring') AND crl_pem IS NOT NULL`,
    );
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  if (!rows.length) return null;
  return rows.map((r) => String(r.crl_pem).trim()).join('\n');
}
