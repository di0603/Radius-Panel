import { randomUUID } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import { config } from '../config.js';
import { panelPool } from '../db/pools.js';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../lib/crypto.js';
import type { Role } from '../lib/jwt.js';

export interface AdminRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  active: 0 | 1;
  failed_attempts: number;
  locked_until: string | null;
  totp_secret: string | null;
  totp_enabled: 0 | 1;
}

export interface PanelSession {
  id: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  ip: string;
  user_agent: string;
}

/* ----------------------------- Intentos de acceso ----------------------------- */

export async function findAdminByUsername(username: string): Promise<AdminRow | undefined> {
  const [rows] = await panelPool.query<AdminRow[]>(
    `SELECT id, username, password_hash, role, active, failed_attempts, locked_until,
            totp_secret, totp_enabled
       FROM panel_admins WHERE username = :u`,
    { u: username },
  );
  return rows[0];
}

export async function findAdminById(id: number): Promise<AdminRow | undefined> {
  const [rows] = await panelPool.query<AdminRow[]>(
    `SELECT id, username, password_hash, role, active, failed_attempts, locked_until,
            totp_secret, totp_enabled
       FROM panel_admins WHERE id = :id`,
    { id },
  );
  return rows[0];
}

/** Deja constancia del intento. Nunca lanza: no debe tumbar el login. */
export async function recordLoginAttempt(
  username: string,
  ip: string,
  success: boolean,
  reason = '',
): Promise<void> {
  try {
    await panelPool.query(
      `INSERT INTO panel_login_attempts (username, ip, success, reason)
       VALUES (:username, :ip, :success, :reason)`,
      { username: username.slice(0, 64), ip: ip.slice(0, 45), success: success ? 1 : 0, reason },
    );
  } catch (err) {
    console.error('[auth] no se pudo registrar el intento de acceso', err);
  }
}

/**
 * Fallos recientes de ese usuario, mire desde donde mire.
 * Complementa al rate-limit por IP: frena el ataque distribuido contra una cuenta.
 */
export async function countRecentFailures(username: string): Promise<number> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM panel_login_attempts
      WHERE username = :u AND success = 0
        AND created_at > (NOW() - INTERVAL :mins MINUTE)`,
    { u: username, mins: config.login.windowMinutes },
  );
  return Number(rows[0]?.n ?? 0);
}

/** Minutos que quedan de bloqueo, o 0 si la cuenta no esta bloqueada. */
export function lockRemainingMinutes(admin: AdminRow): number {
  if (!admin.locked_until) return 0;
  const until = new Date(admin.locked_until.replace(' ', 'T')).getTime();
  if (Number.isNaN(until)) return 0;
  const diffMs = until - Date.now();
  return diffMs > 0 ? Math.ceil(diffMs / 60000) : 0;
}

/** Suma un fallo y bloquea la cuenta si se alcanza el limite. */
export async function registerFailedLogin(adminId: number): Promise<void> {
  await panelPool.query(
    `UPDATE panel_admins
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= :max THEN (NOW() + INTERVAL :lock MINUTE)
              ELSE locked_until
            END
      WHERE id = :id`,
    { id: adminId, max: config.login.maxAttempts, lock: config.login.lockMinutes },
  );
}

export async function clearFailedLogins(adminId: number): Promise<void> {
  await panelPool.query(
    `UPDATE panel_admins
        SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW()
      WHERE id = :id`,
    { id: adminId },
  );
}

/** Desbloqueo manual desde la pagina de administradores. */
export async function unlockAdmin(adminId: number): Promise<void> {
  await panelPool.query(
    `UPDATE panel_admins SET failed_attempts = 0, locked_until = NULL WHERE id = :id`,
    { id: adminId },
  );
}

/* ------------------------------ Refresh tokens ------------------------------- */

interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export async function issueRefreshToken(
  adminId: number,
  ip: string,
  userAgent: string,
  family: string = randomUUID(),
): Promise<IssuedToken> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenDays * 86400_000);
  await panelPool.query(
    `INSERT INTO panel_refresh_tokens (admin_id, token_hash, family, expires_at, ip, user_agent)
     VALUES (:admin_id, :hash, :family, :expires, :ip, :ua)`,
    {
      admin_id: adminId,
      hash: sha256(token),
      family,
      expires: expiresAt,
      ip: ip.slice(0, 45),
      ua: userAgent.slice(0, 255),
    },
  );
  return { token, expiresAt };
}

export type RefreshOutcome =
  | { ok: true; adminId: number; token: string; expiresAt: Date }
  | { ok: false; reason: 'unknown' | 'expired' | 'reused' };

/**
 * Canjea un refresh token por uno nuevo (rotacion).
 *
 * Si llega un token ya usado (revocado) se asume robo: se revoca toda la familia
 * para echar tanto al atacante como al usuario legitimo.
 */
export async function rotateRefreshToken(
  token: string,
  ip: string,
  userAgent: string,
): Promise<RefreshOutcome> {
  const hash = sha256(token);
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT id, admin_id, family, revoked_at, expires_at < NOW() AS expired
       FROM panel_refresh_tokens WHERE token_hash = :hash`,
    { hash },
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };

  if (row.revoked_at) {
    await revokeFamily(String(row.family));
    return { ok: false, reason: 'reused' };
  }
  if (Number(row.expired) === 1) return { ok: false, reason: 'expired' };

  await panelPool.query(
    `UPDATE panel_refresh_tokens SET revoked_at = NOW(), last_used_at = NOW() WHERE id = :id`,
    { id: row.id },
  );
  const next = await issueRefreshToken(Number(row.admin_id), ip, userAgent, String(row.family));
  return { ok: true, adminId: Number(row.admin_id), token: next.token, expiresAt: next.expiresAt };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await panelPool.query(
    `UPDATE panel_refresh_tokens SET revoked_at = NOW()
      WHERE token_hash = :hash AND revoked_at IS NULL`,
    { hash: sha256(token) },
  );
}

async function revokeFamily(family: string): Promise<void> {
  await panelPool.query(
    `UPDATE panel_refresh_tokens SET revoked_at = NOW()
      WHERE family = :family AND revoked_at IS NULL`,
    { family },
  );
}

export async function revokeAllSessions(adminId: number): Promise<number> {
  const [res] = await panelPool.query<ResultSetHeader>(
    `UPDATE panel_refresh_tokens SET revoked_at = NOW()
      WHERE admin_id = :id AND revoked_at IS NULL`,
    { id: adminId },
  );
  return res.affectedRows;
}

/** Sesiones abiertas (no revocadas ni caducadas) de un administrador. */
export async function listSessions(adminId: number): Promise<PanelSession[]> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT id, created_at, last_used_at, expires_at, ip, user_agent
       FROM panel_refresh_tokens
      WHERE admin_id = :id AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC`,
    { id: adminId },
  );
  return rows as PanelSession[];
}

export async function revokeSessionById(id: number, adminId: number): Promise<boolean> {
  const [res] = await panelPool.query<ResultSetHeader>(
    `UPDATE panel_refresh_tokens SET revoked_at = NOW()
      WHERE id = :id AND admin_id = :admin AND revoked_at IS NULL`,
    { id, admin: adminId },
  );
  return res.affectedRows > 0;
}

/** Limpia tokens caducados o revocados hace mas de 30 dias. */
export async function purgeOldTokens(): Promise<number> {
  const [res] = await panelPool.query<ResultSetHeader>(
    `DELETE FROM panel_refresh_tokens
      WHERE expires_at < (NOW() - INTERVAL 30 DAY)
         OR (revoked_at IS NOT NULL AND revoked_at < (NOW() - INTERVAL 30 DAY))`,
  );
  return res.affectedRows;
}

/* ----------------------------------- 2FA ------------------------------------- */

export interface TotpEnrollment {
  secret: string;
  otpauthUrl: string;
}

/** Genera un secreto y lo guarda cifrado, todavia sin activar. */
export async function startTotpEnrollment(
  adminId: number,
  username: string,
): Promise<TotpEnrollment> {
  const secret = generateSecret();
  await panelPool.query(
    `UPDATE panel_admins SET totp_secret = :secret, totp_enabled = 0 WHERE id = :id`,
    { id: adminId, secret: encryptSecret(secret) },
  );
  return {
    secret,
    otpauthUrl: generateURI({ issuer: config.totpIssuer, label: username, secret }),
  };
}

/** Comprueba un codigo de 6 digitos contra el secreto cifrado del administrador. */
export async function verifyTotpCode(encryptedSecret: string, code: string): Promise<boolean> {
  try {
    const result = await verifyOtp({
      secret: decryptSecret(encryptedSecret),
      token: code.replace(/\s+/g, ''),
    });
    return result.valid;
  } catch {
    return false;
  }
}

export async function confirmTotp(adminId: number): Promise<void> {
  await panelPool.query(`UPDATE panel_admins SET totp_enabled = 1 WHERE id = :id`, { id: adminId });
}

export async function disableTotp(adminId: number): Promise<void> {
  await panelPool.query(
    `UPDATE panel_admins SET totp_enabled = 0, totp_secret = NULL WHERE id = :id`,
    { id: adminId },
  );
}
