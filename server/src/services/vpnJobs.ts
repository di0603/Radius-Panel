import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool, radiusPool } from '../db/pools.js';
import { logger } from '../lib/logger.js';
import { regenerateCrl, regenerateDueCrls } from './pki.js';

/**
 * Mantenimiento periodico del modulo VPN, pensado para `npm run vpn:jobs`
 * (deploy/radius-panel-vpn-jobs.timer, cada 15 minutos), no para el proceso
 * de la API: se puede invocar a mano y no compite por el bloqueo con el
 * propio arranque del servidor.
 */

const LOCK_NAME = 'radius_panel_vpn_jobs';
const CRL_REGEN_WITHIN_DAYS = 3;
/** Ventana de deteccion de "recien caducado": mayor que el intervalo del timer (15 min) por margen. */
const RECENTLY_EXPIRED_MINUTES = 20;

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

/** Certificados 'superseded' cuya ventana de solapamiento ya paso -> 'revoked'. Regenera la CRL de cada CA afectada. */
async function reviseSupersededCertificates(): Promise<number> {
  let rows: RowDataPacket[];
  try {
    [rows] = await radiusPool.query<RowDataPacket[]>(
      `SELECT serial, ca_id FROM vpn_certificates
        WHERE status = 'superseded' AND superseded_until IS NOT NULL AND superseded_until < UTC_TIMESTAMP()`,
    );
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
  if (!rows.length) return 0;

  const caIds = new Set<number>();
  for (const row of rows) {
    await radiusPool.query(
      `UPDATE vpn_certificates
          SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), revoke_reason = 'superseded'
        WHERE serial = :serial`,
      { serial: row.serial },
    );
    if (row.ca_id != null) caIds.add(Number(row.ca_id));
  }
  for (const caId of caIds) {
    await regenerateCrl(caId).catch((err) =>
      logger.warn({ err, caId }, 'no se pudo regenerar la CRL tras pasar certificados a revoked'),
    );
  }
  return rows.length;
}

/**
 * Regenera ya mismo la CRL de cualquier CA con un certificado revocado que
 * acaba de caducar (en los ultimos `RECENTLY_EXPIRED_MINUTES`), en vez de
 * esperar al ciclo normal de `regenerateDueCrls`: `getRevokedEntriesForCa`
 * ya los excluye una vez caducados, asi que basta con volver a generar la
 * CRL para que desaparezcan. La ventana temporal evita forzar el mismo
 * regenerado en cada ejecucion para siempre por un certificado ya antiguo.
 */
async function pruneJustExpiredFromCrls(): Promise<number> {
  let rows: RowDataPacket[];
  try {
    [rows] = await radiusPool.query<RowDataPacket[]>(
      `SELECT DISTINCT ca_id FROM vpn_certificates
        WHERE status = 'revoked' AND ca_id IS NOT NULL
          AND not_after BETWEEN (UTC_TIMESTAMP() - INTERVAL :minutes MINUTE) AND UTC_TIMESTAMP()`,
      { minutes: RECENTLY_EXPIRED_MINUTES },
    );
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
  for (const row of rows) {
    await regenerateCrl(Number(row.ca_id)).catch((err) =>
      logger.warn({ err, caId: row.ca_id }, 'no se pudo regenerar la CRL al depurar certificados caducados'),
    );
  }
  return rows.length;
}

/** Tokens de alta EST caducados (usados o no): ya no sirven para nada. */
async function deleteExpiredEnrollTokens(): Promise<number> {
  try {
    const [res] = await panelPool.query<ResultSetHeader>(
      `DELETE FROM panel_vpn_enroll_tokens WHERE expires_at < UTC_TIMESTAMP()`,
    );
    return res.affectedRows;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}

export interface VpnJobsSummary {
  supersededToRevoked: number;
  crlsPrunedNow: number;
  expiredTokensDeleted: number;
  crlsRegenerated: number;
}

/**
 * Ejecuta las cuatro tareas bajo un bloqueo de MySQL (`GET_LOCK`, no un
 * timeout de espera: si ya hay otra ejecucion en marcha se aborta al
 * momento en vez de esperar). El bloqueo se suelta solo al cerrar la
 * conexion (o con `RELEASE_LOCK`), asi que un proceso que muriera a media
 * ejecucion no lo deja colgado.
 */
export async function runVpnJobs(): Promise<VpnJobsSummary | null> {
  const conn = await panelPool.getConnection();
  try {
    const [[lockRow]] = await conn.query<RowDataPacket[]>(
      `SELECT GET_LOCK(:name, 0) AS locked`,
      { name: LOCK_NAME },
    );
    if (Number(lockRow.locked) !== 1) {
      logger.info('vpn:jobs ya se esta ejecutando en otro proceso, se omite esta pasada');
      return null;
    }

    const supersededToRevoked = await reviseSupersededCertificates();
    const crlsPrunedNow = await pruneJustExpiredFromCrls();
    const expiredTokensDeleted = await deleteExpiredEnrollTokens();
    const crlsRegenerated = await regenerateDueCrls(CRL_REGEN_WITHIN_DAYS);

    return { supersededToRevoked, crlsPrunedNow, expiredTokensDeleted, crlsRegenerated };
  } finally {
    await conn.query(`SELECT RELEASE_LOCK(:name)`, { name: LOCK_NAME }).catch(() => undefined);
    conn.release();
  }
}
