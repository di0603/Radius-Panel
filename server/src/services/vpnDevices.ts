import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool, radiusPool } from '../db/pools.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { formatUtcDateTime } from '../lib/dates.js';
import { conflict, notFound } from '../lib/http.js';
import { intToIpv4, ipv4ToInt } from '../lib/ipv4.js';
import { disconnectUserSessions } from './coa.js';
import { regenerateCrl } from './pki.js';
import { setUserEnabled, usernameExists } from './radiusUsers.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Gestion de dispositivos VPN: alta (usuario RADIUS + ficha del panel en una
 * unica operacion), token de alta EST, activar/desactivar, revocar
 * certificado y baja. Ver sql/panel-schema-vpn-devices.sql.
 */

export type DevicePlatform = 'windows' | 'android' | 'linux';
export type TunnelMode = 'full' | 'split';
/** Derivado de `enabled` + `framed_ip`: no hay una columna de estado en el modelo. */
export type DeviceStatus = 'active' | 'disabled' | 'decommissioned';

export interface VpnDevice {
  id: number;
  username: string;
  ownerUser: string;
  deviceLabel: string;
  ownerName: string | null;
  platform: DevicePlatform;
  tunnelMode: TunnelMode;
  notes: string | null;
  certDays: number | null;
  renewAfterDays: number | null;
  framedIp: string | null;
  enabled: boolean;
  status: DeviceStatus;
  /** Excepciones explicitas (marcadas por un admin, con aviso) al bloqueo permanente de RADIUS/MariaDB para clientes VPN. */
  allowRadiusHost: boolean;
  allowMariadbHost: boolean;
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

const NAME_PART_RE = /^[a-z0-9-]{2,32}$/;

/** username = vpn-<owner_user>-<device_label>. Validar ownerUser/deviceLabel en la ruta con NAME_PART_RE. */
export function buildDeviceUsername(ownerUser: string, deviceLabel: string): string {
  return `vpn-${ownerUser}-${deviceLabel}`;
}

export { NAME_PART_RE };

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

function deviceStatus(enabled: boolean, framedIp: string | null): DeviceStatus {
  if (!enabled && !framedIp) return 'decommissioned';
  return enabled ? 'active' : 'disabled';
}

function toDevice(row: RowDataPacket): VpnDevice {
  const enabled = Boolean(row.enabled);
  const framedIp = row.framed_ip ?? null;
  return {
    id: Number(row.id),
    username: row.username,
    ownerUser: row.owner_user,
    deviceLabel: row.device_label,
    ownerName: row.owner_name ?? null,
    platform: row.platform,
    tunnelMode: row.tunnel_mode,
    notes: row.notes ?? null,
    certDays: row.cert_days === null || row.cert_days === undefined ? null : Number(row.cert_days),
    renewAfterDays:
      row.renew_after_days === null || row.renew_after_days === undefined
        ? null
        : Number(row.renew_after_days),
    framedIp,
    enabled,
    status: deviceStatus(enabled, framedIp),
    allowRadiusHost: Boolean(row.allow_radius_host),
    allowMariadbHost: Boolean(row.allow_mariadb_host),
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
  ownerUser: string;
  deviceLabel: string;
  ownerName: string | null;
  platform: DevicePlatform;
  tunnelMode: TunnelMode;
  notes: string | null;
  certDays: number | null;
  renewAfterDays: number | null;
}

/**
 * Da de alta un dispositivo: usuario RADIUS (radcheck/radreply/radusergroup,
 * con la primera IP libre del pool, sin repetir ninguna IP ya usada en
 * radreply por cualquier usuario) + ficha en panel_vpn_devices. username =
 * vpn-<owner_user>-<device_label>, unico.
 *
 * Las dos bases pueden vivir en servidores MySQL distintos (igual que
 * panel_user_meta), asi que no hay una unica transaccion SQL que las cubra
 * a ambas. En su lugar: radcheck/radreply/radusergroup se escriben en una
 * transaccion real (misma base, mismo servidor); si despues falla el INSERT
 * en panel_vpn_devices, se deshacen esas filas a mano para no dejar un
 * usuario RADIUS "fantasma" sin ficha en el panel.
 */
export async function createDevice(input: CreateDeviceInput): Promise<VpnDevice> {
  const username = buildDeviceUsername(input.ownerUser, input.deviceLabel);
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
         (username, owner_user, device_label, owner_name, platform, tunnel_mode, notes, cert_days,
          renew_after_days, framed_ip, enabled)
       VALUES (:username, :ownerUser, :deviceLabel, :ownerName, :platform, :tunnelMode, :notes,
               :certDays, :renewAfterDays, :framedIp, 1)`,
      {
        username,
        ownerUser: input.ownerUser,
        deviceLabel: input.deviceLabel,
        ownerName: input.ownerName,
        platform: input.platform,
        tunnelMode: input.tunnelMode,
        notes: input.notes,
        certDays: input.certDays,
        renewAfterDays: input.renewAfterDays,
        framedIp,
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
 * SHA-256 (`panel_vpn_enroll_tokens.token_sha256`); el valor en claro se
 * devuelve una unica vez, aqui. Generar uno nuevo borra cualquier otro
 * pendiente del mismo dispositivo (no hay estado "revocado": o esta
 * pendiente de usar, o no existe).
 */
export async function generateEnrollToken(
  username: string,
  createdBy: number | null,
): Promise<EnrollToken> {
  await requireDeviceRow(username);

  const token = randomToken();
  const tokenSha256 = sha256(token);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const conn = await panelPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM panel_vpn_enroll_tokens WHERE username = :u AND used_at IS NULL`,
      {
        u: username,
      },
    );
    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO panel_vpn_enroll_tokens (username, token_sha256, expires_at, created_by)
       VALUES (:u, :tokenSha256, :expiresAt, :createdBy)`,
      { u: username, tokenSha256, expiresAt: formatUtcDateTime(expiresAt), createdBy },
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
  await panelPool.query(`UPDATE panel_vpn_devices SET enabled = :enabled WHERE username = :u`, {
    u: username,
    enabled: enabled ? 1 : 0,
  });
  if (!enabled) await disconnectUserSessions(username).catch(() => undefined);
}

/**
 * Revoca el certificado activo del dispositivo, regenera la CRL de la CA que
 * lo firmo (si la conocemos, ver vpn_certificates.ca_id) y desconecta su
 * sesion. No borra nada de RADIUS: para eso esta `decommissionDevice`.
 */
export async function revokeDeviceCertificate(username: string, reason: string): Promise<void> {
  await requireDeviceRow(username);

  const [[cert]] = await radiusPool.query<RowDataPacket[]>(
    `SELECT serial, ca_id FROM vpn_certificates WHERE username = :u AND status = 'active' LIMIT 1`,
    { u: username },
  );
  if (!cert) throw notFound(`El dispositivo "${username}" no tiene ningun certificado activo`);

  await radiusPool.query(
    `UPDATE vpn_certificates
        SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), revoke_reason = :reason
      WHERE serial = :serial`,
    { serial: cert.serial, reason },
  );

  if (cert.ca_id) await regenerateCrl(Number(cert.ca_id));
  await disconnectUserSessions(username).catch(() => undefined);
}

/**
 * Baja definitiva: revoca todos los certificados activos (regenerando la CRL
 * que corresponda), desconecta la sesion, borra las filas RADIUS (libera la
 * IP) y desactiva el dispositivo en el panel. Conserva el historial de
 * vpn_certificates.
 */
export async function decommissionDevice(username: string): Promise<void> {
  await requireDeviceRow(username);

  const [activeCerts] = await radiusPool.query<RowDataPacket[]>(
    `SELECT serial, ca_id FROM vpn_certificates WHERE username = :u AND status = 'active'`,
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

  // enabled=0 + framed_ip=NULL == "dado de baja" (ver deviceStatus): el
  // modelo no tiene una columna de estado propia, se deriva de estas dos.
  await panelPool.query(
    `UPDATE panel_vpn_devices SET enabled = 0, framed_ip = NULL WHERE username = :u`,
    {
      u: username,
    },
  );

  const caIds = new Set(
    activeCerts
      .map((c) => c.ca_id)
      .filter((id) => id != null)
      .map(Number),
  );
  for (const caId of caIds) await regenerateCrl(caId);
}

/**
 * Excepcion explicita al bloqueo permanente de RADIUS/MariaDB para clientes
 * VPN (192.168.10.28/.30, ver services/vpnFirewall.ts): por defecto los dos
 * en `false`. Activarlas es una decision de seguridad real -el admin debe
 * confirmarla con el aviso que muestra la interfaz-, asi que quien la llama
 * es responsable de auditarla (ver routes/vpnDevices.ts).
 */
export async function setDeviceOverrides(
  username: string,
  overrides: { allowRadiusHost?: boolean; allowMariadbHost?: boolean },
): Promise<void> {
  await requireDeviceRow(username);
  const fields: string[] = [];
  const params: Record<string, unknown> = { u: username };
  if (overrides.allowRadiusHost !== undefined) {
    fields.push('allow_radius_host = :allowRadiusHost');
    params.allowRadiusHost = overrides.allowRadiusHost ? 1 : 0;
  }
  if (overrides.allowMariadbHost !== undefined) {
    fields.push('allow_mariadb_host = :allowMariadbHost');
    params.allowMariadbHost = overrides.allowMariadbHost ? 1 : 0;
  }
  if (!fields.length) return;
  await panelPool.query(
    `UPDATE panel_vpn_devices SET ${fields.join(', ')} WHERE username = :u`,
    params as Record<string, string | number>,
  );
}
