import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { panelPool, radiusPool } from '../db/pools.js';
import { formatUtcDateTime } from '../lib/dates.js';
import { badRequest, conflict, forbidden, notFound, unauthorized, type ApiError } from '../lib/http.js';
import { sha256 } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { sha256Hex, x509 } from '../lib/x509.js';
import { signDeviceCsr } from './deviceCerts.js';
import { getActiveIntermediate, getCaCertById, getCaChainPem } from './pki.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Logica de EST (RFC 7030): alta (simpleenroll) y renovacion (simplereenroll)
 * de certificados de dispositivo. Las rutas HTTP/TLS estan en
 * server/src/estServer.ts + server/src/routes/est.ts; este modulo es la
 * parte que toca la base de datos y las reglas de negocio, para poder
 * probarla por separado.
 */

/** Una renovacion por dispositivo como maximo cada 12h, para frenar abuso/bucles. */
export const RENEW_MIN_INTERVAL_HOURS = 12;

export type EstRejectionReason =
  | 'sin_certificado_cliente'
  | 'certificado_desconocido'
  | 'ca_desconocida'
  | 'cadena_invalida'
  | 'certificado_caducado'
  | 'certificado_revocado'
  | 'certificado_no_activo'
  | 'dispositivo_no_encontrado'
  | 'dispositivo_deshabilitado'
  | 'cn_no_coincide'
  | 'csr_firma_invalida'
  | 'clave_reutilizada'
  | 'demasiadas_renovaciones'
  | 'token_invalido'
  | 'sin_ca_activa'
  | 'csr_invalido';

export class EstRejection extends Error {
  readonly reason: EstRejectionReason;
  readonly apiError: ApiError;
  constructor(reason: EstRejectionReason, apiError: ApiError) {
    super(apiError.message);
    this.reason = reason;
    this.apiError = apiError;
  }
}

function reject(reason: EstRejectionReason, apiError: ApiError): never {
  throw new EstRejection(reason, apiError);
}

/* --------------------------------- cacerts -------------------------------- */

/** GET /.well-known/est/cacerts: cadena de CA en PKCS7 "certs-only", base64. RFC 7030 4.1. */
export async function getCaCertsPkcs7Base64(): Promise<string | null> {
  const chainPem = await getCaChainPem();
  if (!chainPem) return null;
  // `new X509Certificates(pem)` interpreta el argumento como un PKCS7 YA
  // EXISTENTE que hay que leer, no como una lista de certificados PEM que
  // envolver en uno nuevo (falla con "Data does not match to ContentInfo
  // ASN1 schema" si se le pasa un PEM con varios certificados concatenados,
  // que es justo lo que devuelve getCaChainPem). Hay que partir el PEM en
  // certificados individuales primero y pasar el array al constructor.
  const certs = x509.PemConverter.decode(chainPem).map((der) => new x509.X509Certificate(der));
  return new x509.X509Certificates(certs).export('base64');
}

/** Envuelve un unico certificado en PKCS7 "certs-only" base64 (respuesta de simpleenroll/simplereenroll). */
export function certToPkcs7Base64(certPem: string): string {
  const certs = new x509.X509Certificates(new x509.X509Certificate(certPem));
  return certs.export('base64');
}

/* ------------------------------- dispositivo ------------------------------ */

export interface EstDevice {
  username: string;
  platform: 'windows' | 'android' | 'linux';
  certDays: number | null;
  renewAfterDays: number | null;
  enabled: boolean;
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export async function findDeviceByUsername(username: string): Promise<EstDevice | null> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT username, platform, cert_days, renew_after_days, enabled
       FROM panel_vpn_devices WHERE username = :u`,
    { u: username },
  );
  if (!row) return null;
  return {
    username: row.username,
    platform: row.platform,
    certDays: toNullableNumber(row.cert_days),
    renewAfterDays: toNullableNumber(row.renew_after_days),
    enabled: Boolean(row.enabled),
  };
}

/** Dias de vigencia del certificado: el del dispositivo si lo tiene, si no el general segun plataforma. */
export async function effectiveCertDays(device: EstDevice): Promise<number> {
  if (device.certDays) return device.certDays;
  const settings = await getVpnSettings();
  return device.platform === 'android' ? settings.androidCertDays : settings.deviceCertDays;
}

/* ----------------------------- token de alta ------------------------------ */

/**
 * Reclama el token de alta de un solo uso de forma atomica: el UPDATE solo
 * afecta a una fila si `used_at` seguia siendo NULL y no habia caducado, asi
 * que dos peticiones concurrentes con el mismo token nunca consiguen las dos
 * `affectedRows === 1`. Se reclama ANTES de validar la firma del CSR contra
 * la CA y de insertar el certificado: panel_vpn_enroll_tokens (radius_panel)
 * y vpn_certificates (radius) viven en pools/conexiones MySQL distintos, asi
 * que no hay una unica transaccion SQL que cubra ambas escrituras. Para que
 * un fallo al firmar no gaste igualmente el token, `enrollDevice` valida el
 * CSR (formato, firma, CN) antes de llegar aqui, y si algo falla DESPUES de
 * reclamar el token (sin CA activa, error de firma, fallo al insertar en
 * vpn_certificates) lo libera con `releaseEnrollToken` para que se pueda
 * reintentar sin que un admin tenga que generar uno nuevo a mano.
 */
export async function claimEnrollToken(username: string, tokenPlain: string): Promise<boolean> {
  const tokenSha256 = sha256(tokenPlain);
  const [result] = await panelPool.query<ResultSetHeader>(
    `UPDATE panel_vpn_enroll_tokens
        SET used_at = UTC_TIMESTAMP()
      WHERE username = :u AND token_sha256 = :hash AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()`,
    { u: username, hash: tokenSha256 },
  );
  return result.affectedRows === 1;
}

/**
 * Contrapartida de `claimEnrollToken`: deja el token otra vez sin usar. Solo
 * la llama `enrollDevice` cuando el token ya se reclamo pero algo ha fallado
 * despues (ver el comentario de `claimEnrollToken`). No comprueba caducidad
 * -- si el token ya ha caducado para cuando se libera, `claimEnrollToken` lo
 * volvera a rechazar en el siguiente intento igualmente.
 */
export async function releaseEnrollToken(username: string, tokenPlain: string): Promise<void> {
  const tokenSha256 = sha256(tokenPlain);
  await panelPool.query(
    `UPDATE panel_vpn_enroll_tokens SET used_at = NULL WHERE username = :u AND token_sha256 = :hash`,
    { u: username, hash: tokenSha256 },
  );
}

/* ---------------------------- vpn_certificates ----------------------------- */

interface CertificateRow extends RowDataPacket {
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

async function getCertificateBySerial(serial: string): Promise<CertificateRow | null> {
  const [[row]] = await radiusPool.query<CertificateRow[]>(
    `SELECT * FROM vpn_certificates WHERE serial = :serial LIMIT 1`,
    { serial },
  );
  return row ?? null;
}

/** Acepta el pool o, dentro de una transaccion (ver `renewDevice`), la conexion que la tiene abierta. */
type Queryable = Pick<Pool | PoolConnection, 'query'>;

export async function insertCertificate(
  input: {
    username: string;
    caId: number;
    serial: string;
    spkiSha256: string;
    notBefore: Date;
    notAfter: Date;
  },
  conn: Queryable = radiusPool,
): Promise<void> {
  await conn.query(
    `INSERT INTO vpn_certificates (username, serial, spki_sha256, ca_id, not_before, not_after, status)
     VALUES (:username, :serial, :spkiSha256, :caId, :notBefore, :notAfter, 'active')`,
    {
      username: input.username,
      serial: input.serial,
      spkiSha256: input.spkiSha256,
      caId: input.caId,
      notBefore: formatUtcDateTime(input.notBefore),
      notAfter: formatUtcDateTime(input.notAfter),
    },
  );
}

export async function supersedeCertificate(
  serial: string,
  overlapHours: number,
  conn: Queryable = radiusPool,
): Promise<void> {
  const supersededUntil = formatUtcDateTime(new Date(Date.now() + overlapHours * 60 * 60 * 1000));
  await conn.query(
    `UPDATE vpn_certificates SET status = 'superseded', superseded_until = :until WHERE serial = :serial`,
    { serial, until: supersededUntil },
  );
}

/* --------------------------------- CSR ------------------------------------ */

/**
 * `tls.PeerCertificate.raw` es un `Buffer`, que estructuralmente no encaja
 * con el `AsnEncodedType` que espera @peculiar/x509 en algunas versiones de
 * @types/node (su `ArrayBufferView` exige `buffer: ArrayBuffer`, y Buffer lo
 * tipa como `ArrayBufferLike`). En tiempo de ejecucion un Buffer es un
 * Uint8Array valido igualmente; el cast solo evita el desajuste de tipos.
 */
function parsePeerCert(der: Buffer | ArrayBuffer): x509.X509Certificate {
  return new x509.X509Certificate(der as unknown as ArrayBuffer);
}

function parseCsr(csrPemOrBase64: string): x509.Pkcs10CertificateRequest {
  try {
    // Pkcs10CertificateRequest detecta PEM/DER/base64 solo: acepta el body
    // tal cual venga, tanto en application/pkcs10 (RFC 7030) como en PEM.
    return new x509.Pkcs10CertificateRequest(csrPemOrBase64.trim());
  } catch {
    throw reject('csr_invalido', badRequest('No se ha podido leer el CSR (PKCS10 o PEM invalido)'));
  }
}

/* ------------------------- validacion del certificado presentado ------------------------- */

/**
 * Cadena hasta la CA que segun `vpn_certificates.ca_id` emitio el
 * certificado, y vigencia. Se comprueban las fechas ANTES de `verify()`:
 * @peculiar/x509 valida la vigencia como parte de la firma (contra "ahora")
 * y, si el certificado ya caduco, devuelve false igual que si la firma fuera
 * invalida -- sin este orden, un certificado caducado saldria como "cadena
 * invalida" en vez de avisar de que el problema es la caducidad (mismo caso
 * ya visto en validateIntermediateImport, ver services/pki.ts).
 */
async function assertChainValid(clientCert: x509.X509Certificate, caId: number | null): Promise<void> {
  if (!caId) reject('ca_desconocida', unauthorized('No se puede validar la cadena de este certificado'));
  const caCert = await getCaCertById(caId);
  if (!caCert) reject('ca_desconocida', unauthorized('La CA que firmo este certificado ya no existe'));

  const now = new Date();
  if (now < clientCert.notBefore || now > clientCert.notAfter) {
    reject('certificado_caducado', unauthorized('El certificado presentado esta caducado'));
  }

  const chainOk = await clientCert.verify({ publicKey: caCert.publicKey });
  if (!chainOk) reject('cadena_invalida', unauthorized('La cadena de confianza no es valida'));
}

/** Ni 'superseded' ni 'revoked' pueden renovar ni dar estado: solo 'active'. */
function assertCertificateRowActive(row: CertificateRow): void {
  if (row.status === 'revoked') {
    reject('certificado_revocado', unauthorized('El certificado presentado esta revocado'));
  }
  if (row.status !== 'active') {
    reject('certificado_no_activo', unauthorized('El certificado presentado no esta activo'));
  }
}

/** El CN del propio certificado presentado debe coincidir con el username de su fila (SAN dNSName = CN, ver CLAUDE.md). */
function assertCertCnMatchesUsername(clientCert: x509.X509Certificate, username: string): void {
  const certCn = clientCert.subjectName.getField('CN')[0] ?? '';
  if (certCn !== username) {
    reject(
      'cn_no_coincide',
      unauthorized('El CN del certificado presentado no coincide con el dispositivo registrado'),
    );
  }
}

/**
 * Validacion comun del certificado de cliente TLS presentado, usada tanto en
 * `simplereenroll` como en `status`: localiza su fila por serial y comprueba
 * fechas, cadena hasta su CA, estado 'active' y que el CN coincida con el
 * username de la fila. `renewDevice` repite estos mismos pasos (no esta
 * funcion) porque necesita hacerlo dentro de una transaccion con las filas
 * bloqueadas (ver su comentario).
 */
async function verifyPresentedCertificate(
  clientCertDer: Buffer | ArrayBuffer,
): Promise<{ clientCert: x509.X509Certificate; row: CertificateRow }> {
  let clientCert: x509.X509Certificate;
  try {
    clientCert = parsePeerCert(clientCertDer);
  } catch {
    reject('sin_certificado_cliente', unauthorized('No se ha presentado un certificado de cliente valido'));
  }

  const serial = clientCert.serialNumber.toLowerCase();
  const row = await getCertificateBySerial(serial);
  if (!row) reject('certificado_desconocido', unauthorized('Certificado no reconocido'));

  await assertChainValid(clientCert, row.ca_id);
  assertCertificateRowActive(row);
  assertCertCnMatchesUsername(clientCert, row.username);

  return { clientCert, row };
}

/* ------------------------------ simpleenroll ------------------------------- */

export interface EnrollResult {
  certPem: string;
  serial: string;
}

/**
 * POST /.well-known/est/simpleenroll ya autenticado (HTTP Basic: usuario =
 * nombre del dispositivo, contrasena = token de alta) por la ruta HTTP. Aqui
 * solo la logica, EN ESTE ORDEN:
 *   1. CSR valido (formato, firma -- prueba de posesion de la clave -- y CN
 *      == usuario autenticado), ANTES de tocar el token: si el CSR es
 *      invalido no tiene sentido gastarlo.
 *   2. dispositivo habilitado (si existe).
 *   3. reclamar el token. Un dispositivo desconocido y un token incorrecto
 *      responden EXACTAMENTE igual (401, mismo mensaje): que exista o no ese
 *      username no se puede deducir desde fuera. El motivo real (cual de los
 *      dos fue) solo queda en la auditoria via `err.reason`.
 *   4. firmar e insertar. Si algo de esto falla, el token reclamado en el
 *      paso 3 se libera (`releaseEnrollToken`) para no dejar al dispositivo
 *      sin alta por un error transitorio.
 */
export async function enrollDevice(input: {
  username: string;
  token: string;
  csrBody: string;
}): Promise<EnrollResult> {
  const csr = parseCsr(input.csrBody);
  if (!(await csr.verify())) {
    reject('csr_firma_invalida', badRequest('La firma del CSR no es valida'));
  }
  const csrCn = csr.subjectName.getField('CN')[0] ?? '';
  if (csrCn !== input.username) {
    reject('cn_no_coincide', badRequest('El CN del CSR no coincide con el usuario autenticado'));
  }

  const device = await findDeviceByUsername(input.username);
  if (device && !device.enabled) {
    reject('dispositivo_deshabilitado', forbidden('Dispositivo deshabilitado'));
  }

  const claimed = await claimEnrollToken(input.username, input.token);
  if (!device || !claimed) {
    reject(
      device ? 'token_invalido' : 'dispositivo_no_encontrado',
      unauthorized('Dispositivo o token de alta invalidos'),
    );
  }

  try {
    let active;
    try {
      active = await getActiveIntermediate();
    } catch {
      reject('sin_ca_activa', conflict('No hay ninguna CA intermedia activa'));
    }

    const days = await effectiveCertDays(device);
    const signed = await signDeviceCsr({
      csrPem: input.csrBody,
      cn: input.username,
      days,
      issuerCert: active.cert,
      signingKey: active.signingKey,
    });

    await insertCertificate({
      username: input.username,
      caId: active.id,
      serial: signed.serial,
      spkiSha256: signed.spkiSha256,
      notBefore: signed.notBefore,
      notAfter: signed.notAfter,
    });

    return { certPem: signed.certPem, serial: signed.serial };
  } catch (err) {
    await releaseEnrollToken(input.username, input.token).catch((releaseErr: unknown) => {
      logger.error(
        { err: releaseErr, username: input.username },
        '[est] no se ha podido liberar el token de alta tras un fallo al firmar',
      );
    });
    throw err;
  }
}

/* ----------------------------- simplereenroll ------------------------------ */

/**
 * POST /.well-known/est/simplereenroll. `clientCertDer` es el certificado
 * presentado en el TLS mutuo (ya lo exige la ruta con `requestCert: true`).
 *
 * Todo, desde que se localiza la fila del certificado hasta que se inserta
 * el nuevo, ocurre dentro de UNA transaccion de `radiusPool` con las filas
 * del dispositivo bloqueadas (`SELECT ... FOR UPDATE`), para que dos
 * renovaciones concurrentes del mismo dispositivo no pasen las dos a la vez
 * (ver el test de concurrencia en est.test.ts): la segunda, al bloquearse
 * hasta que la primera confirme, vuelve a leer el estado YA actualizado (el
 * certificado presentado ya 'superseded', o la clave ya usada, o el limite
 * de frecuencia ya alcanzado) en vez de trabajar con datos obsoletos.
 *
 * Primero se localiza la fila por el serial del certificado presentado (para
 * saber de que dispositivo se trata sin fiarse todavia de su CN) y LUEGO se
 * bloquean todas las filas de ese username -- el limite de frecuencia y la
 * reutilizacion de clave se comprueban contra esa lectura ya bloqueada, no
 * contra una lectura anterior sin bloquear.
 *
 * Comprueba, EN ESTE ORDEN, parando en el primer fallo:
 *   1. cadena hasta la raiz via una intermedia nuestra (vpn_certificates.ca_id);
 *   2. no caducado;
 *   3. no revocado;
 *   4. estado 'active' (ni 'superseded' ni 'revoked' pueden renovar);
 *   5. CN del certificado presentado == username de su fila;
 *   6. dispositivo habilitado;
 *   7. CN del CSR == username de la fila;
 *   8. firma del CSR valida;
 *   9. clave del CSR distinta de todas las anteriores del dispositivo;
 *   10. limite de frecuencia (una renovacion cada RENEW_MIN_INTERVAL_HOURS).
 * Si todo pasa: firma el nuevo, lo guarda 'active' y marca el presentado
 * 'superseded' con `superseded_until = ahora + overlapHours`, todo en la
 * misma transaccion.
 */
export async function renewDevice(input: {
  clientCertDer: Buffer | ArrayBuffer;
  csrBody: string;
}): Promise<EnrollResult> {
  let clientCert: x509.X509Certificate;
  try {
    clientCert = parsePeerCert(input.clientCertDer);
  } catch {
    reject('sin_certificado_cliente', unauthorized('No se ha presentado un certificado de cliente valido'));
  }
  const serial = clientCert.serialNumber.toLowerCase();

  const conn = await radiusPool.getConnection();
  try {
    await conn.beginTransaction();

    const [[preliminaryRow]] = await conn.query<CertificateRow[]>(
      `SELECT * FROM vpn_certificates WHERE serial = :serial FOR UPDATE`,
      { serial },
    );
    if (!preliminaryRow) reject('certificado_desconocido', unauthorized('Certificado no reconocido'));

    const [rows] = await conn.query<CertificateRow[]>(
      `SELECT * FROM vpn_certificates WHERE username = :u FOR UPDATE`,
      { u: preliminaryRow.username },
    );
    const row = rows.find((r) => r.serial === serial);
    if (!row) reject('certificado_desconocido', unauthorized('Certificado no reconocido'));

    await assertChainValid(clientCert, row.ca_id);
    assertCertificateRowActive(row);
    assertCertCnMatchesUsername(clientCert, row.username);

    const device = await findDeviceByUsername(row.username);
    if (!device) reject('dispositivo_no_encontrado', notFound('Dispositivo desconocido'));
    if (!device.enabled) reject('dispositivo_deshabilitado', forbidden('Dispositivo deshabilitado'));

    const csr = parseCsr(input.csrBody);
    const csrCn = csr.subjectName.getField('CN')[0] ?? '';
    if (csrCn !== row.username) {
      reject('cn_no_coincide', badRequest('El CN del CSR no coincide con el certificado presentado'));
    }

    if (!(await csr.verify())) {
      reject('csr_firma_invalida', badRequest('La firma del CSR no es valida'));
    }

    const newSpki = sha256Hex(csr.publicKey.rawData);
    if (rows.some((r) => r.spki_sha256 === newSpki)) {
      reject('clave_reutilizada', badRequest('La clave del CSR ya se ha usado antes para este dispositivo'));
    }

    const lastIssuedAtMs = Math.max(...rows.map((r) => Date.parse(`${r.created_at.replace(' ', 'T')}Z`)));
    if (Date.now() - lastIssuedAtMs < RENEW_MIN_INTERVAL_HOURS * 60 * 60 * 1000) {
      reject(
        'demasiadas_renovaciones',
        conflict(`Solo se permite una renovacion cada ${RENEW_MIN_INTERVAL_HOURS}h`),
      );
    }

    let active;
    try {
      active = await getActiveIntermediate();
    } catch {
      reject('sin_ca_activa', conflict('No hay ninguna CA intermedia activa'));
    }

    const days = await effectiveCertDays(device);
    const settings = await getVpnSettings();
    const signed = await signDeviceCsr({
      csrPem: input.csrBody,
      cn: row.username,
      days,
      issuerCert: active.cert,
      signingKey: active.signingKey,
    });

    await insertCertificate(
      {
        username: row.username,
        caId: active.id,
        serial: signed.serial,
        spkiSha256: signed.spkiSha256,
        notBefore: signed.notBefore,
        notAfter: signed.notAfter,
      },
      conn,
    );
    await supersedeCertificate(serial, settings.overlapHours, conn);

    await conn.commit();
    return { certPem: signed.certPem, serial: signed.serial };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ---------------------------------- status ---------------------------------- */

export interface EstStatus {
  username: string;
  notAfter: string;
  renewDue: boolean;
}

/** GET /.well-known/est/status (opcional, con certificado de cliente): misma validacion que simplereenroll (ver `verifyPresentedCertificate`). */
export async function getStatus(clientCertDer: Buffer | ArrayBuffer): Promise<EstStatus> {
  const { row } = await verifyPresentedCertificate(clientCertDer);

  const device = await findDeviceByUsername(row.username);
  const settings = await getVpnSettings();
  const renewAfterDays = device?.renewAfterDays ?? settings.renewAfterDays;
  const notBefore = new Date(`${String(row.not_before).replace(' ', 'T')}Z`);
  const renewDue = Date.now() >= notBefore.getTime() + renewAfterDays * 24 * 60 * 60 * 1000;

  return { username: row.username, notAfter: row.not_after, renewDue };
}
