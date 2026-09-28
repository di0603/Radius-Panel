import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool, radiusPool } from '../db/pools.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { conflict, notFound } from '../lib/http.js';
import { intToIpv4, ipv4ToInt } from '../lib/ipv4.js';
import { disconnectUserSessions } from './coa.js';
import { regenerateCrlBySerial } from './pki.js';
import { setUserEnabled, usernameExists } from './radiusUsers.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Gestion de dispositivos VPN: alta (usuario RADIUS + ficha del panel en una
 * unica operacion), token de alta EST, activar/desactivar, revocar
 * certificado y baja. Ver sql/panel-schema-vpn-devices.sql.
 */

export type DevicePlatform = 'windows' | 'android' | 'linux';
export type TunnelMode = 'full' | 'split';
export type DeviceStatus = 'pending' | 'active' | 'disabled' | 'revoked';

export interface VpnDevice {
  id: number;
  username: string;
  owner: string | null;
  platform: DevicePlatform;
  tunnelMode: TunnelMode;
  notes: string | null;
  certDays: number | null;
  renewAfterDays: number | null;
  framedIp: string | null;
  status: DeviceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceCertificateSummary {
  serial: string;
  status: 'active' | 'superseded' | 'revoked';
  notBefore: string;
  notAfter: string;
  createdAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface VpnDeviceDetail extends VpnDevice {
  certificates: DeviceCertificateSummary[];
  lastIssuedAt: string | null;
  nextRenewalExpectedAt: string | null;
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

function toDevice(row: RowDataPacket): VpnDevice {
  return {
    id: Number(row.id),
    username: row.username,
    owner: row.owner ?? null,
    platform: row.platform,
    tunnelMode: row.tunnel_mode,
    notes: row.notes ?? null,
    certDays: row.cert_days === null || row.cert_days === undefined ? null : Number(row.cert_days),
    renewAfterDays:
      row.renew_after_days === null || row.renew_after_days === undefined
        ? null
        : Number(row.renew_after_days),
    framedIp: row.framed_ip ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireDeviceRow(username: string): Promise<RowDataPacket> {
  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT * FROM panel_vpn_devices WHERE username = :u LIMIT 1`,
    { u: username },
  );
  if (!row) throw notFound(`No existe el dispositivo "${username}"`);
  return row;
}

export async function listDevices(): Promise<VpnDevice[]> {
  try {
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT * FROM panel_vpn_devices ORDER BY created_at DESC`,
    );
    return rows.map(toDevice);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export async function getDeviceDetail(username: string): Promise<VpnDeviceDetail> {
  const device = toDevice(await requireDeviceRow(username));

  const [certRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT serial, status, not_before, not_after, created_at, revoked_at, revoke_reason
       FROM vpn_certificates WHERE username = :u ORDER BY created_at DESC`,
    { u: username },
  );
  const certificates: DeviceCertificateSummary[] = certRows.map((r) => ({
    serial: r.serial,
    status: r.status,
    notBefore: r.not_before,
    notAfter: r.not_after,
    createdAt: r.created_at,
    revokedAt: r.revoked_at ?? null,
    revokeReason: r.revoke_reason ?? null,
  }));

  const activeCert = certRows.find((r) => r.status === 'active');
  let lastIssuedAt: string | null = null;
  let nextRenewalExpectedAt: string | null = null;
  if (activeCert) {
    lastIssuedAt = activeCert.not_before;
    const settings = await getVpnSettings();
    const renewAfterDays = device.renewAfterDays ?? settings.renewAfterDays;
    const base = new Date(`${String(activeCert.not_before).replace(' ', 'T')}Z`);
    nextRenewalExpectedAt = new Date(base.getTime() + renewAfterDays * 86_400_000).toISOString();
  }

  return { ...device, certificates, lastIssuedAt, nextRenewalExpectedAt };
}

/** Primera IP libre del rango, o `null` si esta lleno. Pura: sin acceso a la base de datos. */
export function firstFreeIp(
  poolStart: string,
  poolEnd: string,
  usedIps: Iterable<string>,
): string | null {
  const used = new Set(usedIps);
  const start = ipv4ToInt(poolStart);
  const end = ipv4ToInt(poolEnd);
  for (let n = start; n <= end; n++) {
    const ip = intToIpv4(n);
    if (!used.has(ip)) return ip;
  }
  return null;
}

export interface CreateDeviceInput {
  /** Sin el prefijo "vpn-": lo anade esta funcion. Validar [a-z0-9-]{3,32} en la ruta. */
  name: string;
  owner: string | null;
  platform: DevicePlatform;
  tunnelMode: TunnelMode;
  notes: string | null;
  certDays: number | null;
  renewAfterDays: number | null;
  createdBy: number | null;
}

/**
 * Da de alta un dispositivo: usuario RADIUS (radcheck/radreply/radusergroup,
 * con la primera IP libre del pool) + ficha en panel_vpn_devices.
 *
 * Las dos bases pueden vivir en servidores MySQL distintos (igual que
 * panel_user_meta), asi que no hay una unica transaccion SQL que las cubra
 * a ambas. En su lugar: radcheck/radreply/radusergroup se escriben en una
 * transaccion real (misma base, mismo servidor); si despues falla el INSERT
 * en panel_vpn_devices, se deshacen esas filas a mano para no dejar un
 * usuario RADIUS "fantasma" sin ficha en el panel.
 */
export async function createDevice(input: CreateDeviceInput): Promise<VpnDevice> {
  const username = `vpn-${input.name}`;
  if (await usernameExists(username)) {
    throw conflict(`Ya existe un usuario RADIUS "${username}"`);
  }

  const settings = await getVpnSettings();
  let framedIp = '';

  const conn = await radiusPool.getConnection();
  try {
    await conn.beginTransaction();

    const [ipRows] = await conn.query<RowDataPacket[]>(
      `SELECT value FROM radreply WHERE attribute = 'Framed-IP-Address'`,
    );
    const ip = firstFreeIp(
      settings.poolStart,
      settings.poolEnd,
      ipRows.map((r) => String(r.value)),
    );
    if (!ip) throw conflict('No quedan IPs libres en el rango configurado para la VPN');
    framedIp = ip;

    // Sin esta fila en radcheck, rlm_sql no aplica radreply y el dispositivo
    // se queda sin IP (leccion de la puesta en marcha, ver memoria del proyecto).
    await conn.query(
      `INSERT INTO radcheck (username, attribute, op, value) VALUES (:u, 'Service-Type', '==', 'Framed-User')`,
      { u: username },
    );
    await conn.query(
      `INSERT INTO radreply (username, attribute, op, value) VALUES (:u, 'Framed-IP-Address', ':=', :ip)`,
      { u: username, ip: framedIp },
    );
    await conn.query(
      `INSERT INTO radusergroup (username, groupname, priority) VALUES (:u, 'vpn', 1)`,
      { u: username },
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  try {
    const [result] = await panelPool.query<ResultSetHeader>(
      `INSERT INTO panel_vpn_devices
         (username, owner, platform, tunnel_mode, notes, cert_days, renew_after_days, framed_ip, status, created_by)
       VALUES (:username, :owner, :platform, :tunnelMode, :notes, :certDays, :renewAfterDays, :framedIp, 'active', :createdBy)`,
      {
        username,
        owner: input.owner,
        platform: input.platform,
        tunnelMode: input.tunnelMode,
        notes: input.notes,
        certDays: input.certDays,
        renewAfterDays: input.renewAfterDays,
        framedIp,
        createdBy: input.createdBy,
      },
    );
    const [[row]] = await panelPool.query<RowDataPacket[]>(
      `SELECT * FROM panel_vpn_devices WHERE id = :id`,
      { id: result.insertId },
    );
    return toDevice(row);
  } catch (err) {
    await Promise.all([
      radiusPool.query(`DELETE FROM radcheck WHERE username = :u`, { u: username }),
      radiusPool.query(`DELETE FROM radreply WHERE username = :u`, { u: username }),
      radiusPool.query(`DELETE FROM radusergroup WHERE username = :u`, { u: username }),
    ]);
    throw err;
  }
}

export interface EnrollToken {
  id: number;
  token: string;
  expiresAt: string;
}

/**
 * Token de alta EST de un solo uso, valido 24h. Solo se guarda su hash
 * SHA-256 (`panel_vpn_enroll_tokens.token_hash`); el valor en claro se
 * devuelve una unica vez, aqui. Generar uno nuevo invalida cualquier otro
 * pendiente del mismo dispositivo.
 */
export async function generateEnrollToken(
  username: string,
  createdBy: number | null,
): Promise<EnrollToken> {
  await requireDeviceRow(username);

  const token = randomToken();
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const conn = await panelPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE panel_vpn_enroll_tokens SET revoked_at = NOW()
        WHERE username = :u AND used_at IS NULL AND revoked_at IS NULL`,
      { u: username },
    );
    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO panel_vpn_enroll_tokens (username, token_hash, expires_at, created_by)
       VALUES (:u, :tokenHash, :expiresAt, :createdBy)`,
      { u: username, tokenHash, expiresAt, createdBy },
    );
    await conn.commit();
    return { id: result.insertId, token, expiresAt: expiresAt.toISOString() };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Activa o desactiva un dispositivo reutilizando el mecanismo generico de
 * usuarios (`Auth-Type := Reject`). Al desactivar, desconecta su sesion si
 * tiene una activa (best-effort: no falla la desactivacion si el NAS no
 * responde o si COA_ENABLED esta en false).
 */
export async function setDeviceEnabled(username: string, enabled: boolean): Promise<void> {
  await requireDeviceRow(username);
  await setUserEnabled(username, enabled);
  await panelPool.query(`UPDATE panel_vpn_devices SET status = :status WHERE username = :u`, {
    u: username,
    status: enabled ? 'active' : 'disabled',
  });
  if (!enabled) await disconnectUserSessions(username).catch(() => undefined);
}

/**
 * Revoca el certificado activo del dispositivo, regenera la CRL de la CA que
 * lo firmo (si la conocemos, ver vpn_certificates.ca_serial) y desconecta su
 * sesion. No borra nada de RADIUS: para eso esta `decommissionDevice`.
 */
export async function revokeDeviceCertificate(username: string, reason: string): Promise<void> {
  await requireDeviceRow(username);

  const [[cert]] = await radiusPool.query<RowDataPacket[]>(
    `SELECT serial, ca_serial FROM vpn_certificates WHERE username = :u AND status = 'active' LIMIT 1`,
    { u: username },
  );
  if (!cert) throw notFound(`El dispositivo "${username}" no tiene ningun certificado activo`);

  await radiusPool.query(
    `UPDATE vpn_certificates
        SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), revoke_reason = :reason
      WHERE serial = :serial`,
    { serial: cert.serial, reason },
  );

  if (cert.ca_serial) await regenerateCrlBySerial(String(cert.ca_serial));
  await disconnectUserSessions(username).catch(() => undefined);
}

/**
 * Baja definitiva: revoca todos los certificados activos (regenerando la CRL
 * que corresponda), desconecta la sesion, borra las filas RADIUS (libera la
 * IP) y marca el dispositivo como "revoked" en el panel. Conserva el
 * historial de vpn_certificates.
 */
export async function decommissionDevice(username: string): Promise<void> {
  await requireDeviceRow(username);

  const [activeCerts] = await radiusPool.query<RowDataPacket[]>(
    `SELECT serial, ca_serial FROM vpn_certificates WHERE username = :u AND status = 'active'`,
    { u: username },
  );
  for (const cert of activeCerts) {
    await radiusPool.query(
      `UPDATE vpn_certificates
          SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), revoke_reason = 'device-decommissioned'
        WHERE serial = :serial`,
      { serial: cert.serial },
    );
  }

  await disconnectUserSessions(username).catch(() => undefined);

  const conn = await radiusPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM radcheck WHERE username = :u`, { u: username });
    await conn.query(`DELETE FROM radreply WHERE username = :u`, { u: username });
    await conn.query(`DELETE FROM radusergroup WHERE username = :u`, { u: username });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await panelPool.query(
    `UPDATE panel_vpn_devices SET status = 'revoked', framed_ip = NULL WHERE username = :u`,
    { u: username },
  );

  const caSerials = new Set(
    activeCerts
      .map((c) => c.ca_serial)
      .filter(Boolean)
      .map(String),
  );
  for (const caSerial of caSerials) await regenerateCrlBySerial(caSerial);
}
