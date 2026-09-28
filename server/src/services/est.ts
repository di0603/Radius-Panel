import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool, radiusPool } from '../db/pools.js';
import { formatUtcDateTime } from '../lib/dates.js';
import { badRequest, conflict, forbidden, notFound, unauthorized, type ApiError } from '../lib/http.js';
import { sha256 } from '../lib/crypto.js';
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
 * `affectedRows === 1`. Se reclama ANTES de firmar el certificado (no al
 * reves): panel_vpn_enroll_tokens y vpn_certificates pueden vivir en
 * servidores MySQL distintos, asi que no hay una unica transaccion que cubra
 * ambas escrituras. Si firmar fallara despues de reclamar el token, el
 * dispositivo se queda sin alta y hace falta generar un token nuevo — peor
 * que si permitieramos reutilizar el token tras un fallo (eso si seria un
 * problema de seguridad real).
 */
export async function claimEnrollToken(username: string, tokenPlain: string): Promise<boolean> {
  const tokenSha256 = sha256(tokenPlain);
  const [result] = await panelPool.query<ResultSetHeader>(
    `UPDATE panel_vpn_enroll_tokens
        SET used_at = NOW()
      WHERE username = :u AND token_sha256 = :hash AND used_at IS NULL AND expires_at > NOW()`,
    { u: username, hash: tokenSha256 },
  );
  return result.affectedRows === 1;
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

async function getAllSpkisForUsername(username: string): Promise<Set<string>> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT spki_sha256 FROM vpn_certificates WHERE username = :u`,
    { u: username },
  );
  return new Set(rows.map((r) => String(r.spki_sha256)));
}

async function getLastCertificateAt(username: string): Promise<Date | null> {
  const [[row]] = await radiusPool.query<RowDataPacket[]>(
    `SELECT created_at FROM vpn_certificates WHERE username = :u ORDER BY created_at DESC LIMIT 1`,
    { u: username },
  );
  if (!row) return null;
  return new Date(`${String(row.created_at).replace(' ', 'T')}Z`);
}

async function insertCertificate(input: {
  username: string;
  caId: number;
  serial: string;
  spkiSha256: string;
  notBefore: Date;
  notAfter: Date;
}): Promise<void> {
  await radiusPool.query(
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

async function supersedeCertificate(serial: string, overlapHours: number): Promise<void> {
  const supersededUntil = formatUtcDateTime(new Date(Date.now() + overlapHours * 60 * 60 * 1000));
  await radiusPool.query(
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

/* ------------------------------ simpleenroll ------------------------------- */

export interface EnrollResult {
  certPem: string;
  serial: string;
}

/**
 * POST /.well-known/est/simpleenroll ya autenticado (HTTP Basic: usuario =
 * nombre del dispositivo, contrasena = token de alta) por la ruta HTTP. Aqui
 * solo la logica: reclamar el token, firmar y guardar.
 */
export async function enrollDevice(input: {
  username: string;
  token: string;
  csrBody: string;
}): Promise<EnrollResult> {
  const device = await findDeviceByUsername(input.username);
  if (!device) reject('dispositivo_no_encontrado', notFound('Dispositivo desconocido'));
  if (!device.enabled) reject('dispositivo_deshabilitado', forbidden('Dispositivo deshabilitado'));

  const claimed = await claimEnrollToken(input.username, input.token);
  if (!claimed) reject('token_invalido', unauthorized('Token de alta invalido, caducado o ya usado'));

  const csr = parseCsr(input.csrBody);
  const csrCn = csr.subjectName.getField('CN')[0] ?? '';
  if (csrCn !== input.username) {
    reject('cn_no_coincide', badRequest('El CN del CSR no coincide con el usuario autenticado'));
  }

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
}

/* ----------------------------- simplereenroll ------------------------------ */

/**
 * POST /.well-known/est/simplereenroll. `clientCertDer` es el certificado
 * presentado en el TLS mutuo (ya lo exige la ruta con `requestCert: true`).
 * Comprueba, EN ESTE ORDEN, parando en el primer fallo:
 *   1. cadena hasta la raiz via una intermedia nuestra (vpn_certificates.ca_id);
 *   2. no caducado;
 *   3. no revocado;
 *   4. estado 'active' (ni 'superseded' ni 'revoked' pueden renovar);
 *   5. dispositivo habilitado;
 *   6. CN del CSR == CN del certificado presentado;
 *   7. firma del CSR valida;
 *   8. clave del CSR distinta de todas las anteriores del dispositivo;
 *   9. limite de frecuencia (una renovacion cada RENEW_MIN_INTERVAL_HOURS).
 * Si todo pasa: firma el nuevo, lo guarda 'active' y marca el presentado
 * 'superseded' con `superseded_until = ahora + overlapHours`.
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
  const row = await getCertificateBySerial(serial);
  if (!row) reject('certificado_desconocido', unauthorized('Certificado no reconocido'));

  if (!row.ca_id) reject('ca_desconocida', unauthorized('No se puede validar la cadena de este certificado'));
  const caCert = await getCaCertById(row.ca_id);
  if (!caCert) reject('ca_desconocida', unauthorized('La CA que firmo este certificado ya no existe'));

  // La comprobacion de fecha va antes que `verify()`: @peculiar/x509 valida la
  // vigencia como parte de la firma (contra "ahora") y, si el certificado ya
  // caduco, devuelve false igual que si la firma fuera invalida -- sin este
  // orden, un certificado caducado saldria como "cadena invalida" en vez de
  // avisar de que el problema es la caducidad (mismo caso ya visto en
  // validateIntermediateImport, ver services/pki.ts).
  const now = new Date();
  if (now < clientCert.notBefore || now > clientCert.notAfter) {
    reject('certificado_caducado', unauthorized('El certificado presentado esta caducado'));
  }

  const chainOk = await clientCert.verify({ publicKey: caCert.publicKey });
  if (!chainOk) reject('cadena_invalida', unauthorized('La cadena de confianza no es valida'));

  if (row.status === 'revoked') {
    reject('certificado_revocado', unauthorized('El certificado presentado esta revocado'));
  }
  if (row.status !== 'active') {
    reject('certificado_no_activo', unauthorized('El certificado presentado no esta activo'));
  }

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
  const previousSpkis = await getAllSpkisForUsername(row.username);
  if (previousSpkis.has(newSpki)) {
    reject('clave_reutilizada', badRequest('La clave del CSR ya se ha usado antes para este dispositivo'));
  }

  const lastIssuedAt = await getLastCertificateAt(row.username);
  if (lastIssuedAt && now.getTime() - lastIssuedAt.getTime() < RENEW_MIN_INTERVAL_HOURS * 60 * 60 * 1000) {
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

  await insertCertificate({
    username: row.username,
    caId: active.id,
    serial: signed.serial,
    spkiSha256: signed.spkiSha256,
    notBefore: signed.notBefore,
    notAfter: signed.notAfter,
  });
  await supersedeCertificate(serial, settings.overlapHours);

  return { certPem: signed.certPem, serial: signed.serial };
}

/* ---------------------------------- status ---------------------------------- */

export interface EstStatus {
  username: string;
  notAfter: string;
  renewDue: boolean;
}

/** GET /.well-known/est/status (opcional, con certificado de cliente). */
export async function getStatus(clientCertDer: Buffer | ArrayBuffer): Promise<EstStatus> {
  let clientCert: x509.X509Certificate;
  try {
    clientCert = parsePeerCert(clientCertDer);
  } catch {
    reject('sin_certificado_cliente', unauthorized('No se ha presentado un certificado de cliente valido'));
  }

  const serial = clientCert.serialNumber.toLowerCase();
  const row = await getCertificateBySerial(serial);
  if (!row || row.status !== 'active') {
    reject('certificado_desconocido', unauthorized('Certificado no reconocido o no activo'));
  }

  const device = await findDeviceByUsername(row.username);
  const settings = await getVpnSettings();
  const renewAfterDays = device?.renewAfterDays ?? settings.renewAfterDays;
  const notBefore = new Date(`${String(row.not_before).replace(' ', 'T')}Z`);
  const renewDue = Date.now() >= notBefore.getTime() + renewAfterDays * 24 * 60 * 60 * 1000;

  return { username: row.username, notAfter: row.not_after, renewDue };
}
