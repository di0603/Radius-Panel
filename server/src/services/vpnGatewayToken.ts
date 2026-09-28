import type { RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.js';

/**
 * Token de la puerta de enlace VPN (VM 192.168.10.29): autentica
 * `GET /vpn/gateway/firewall.nft`. Solo se guarda su hash SHA-256
 * (`panel_vpn_settings.gateway_token_sha256`); el valor en claro se ensena
 * una unica vez al generarlo o regenerarlo, igual que un token de alta EST.
 */

function isMissingColumn(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
}

/** Para la pagina de ajustes: si ya hay un token generado, sin revelar nada de el. */
export async function hasGatewayToken(): Promise<boolean> {
  try {
    const [[row]] = await panelPool.query<RowDataPacket[]>(
      `SELECT gateway_token_sha256 FROM panel_vpn_settings WHERE id = 1`,
    );
    return !!row?.gateway_token_sha256;
  } catch (err) {
    if (isMissingColumn(err)) return false;
    throw err;
  }
}

/** Genera un token nuevo (invalida cualquier anterior). Devuelve el valor en claro, solo aqui. */
export async function generateGatewayToken(): Promise<string> {
  const token = randomToken();
  await panelPool.query(`UPDATE panel_vpn_settings SET gateway_token_sha256 = :hash WHERE id = 1`, {
    hash: sha256(token),
  });
  return token;
}

/** Compara en tiempo constante contra el hash guardado. `false` si no hay ningun token generado todavia. */
export async function verifyGatewayToken(tokenPlain: string): Promise<boolean> {
  let stored: string | null = null;
  try {
    const [[row]] = await panelPool.query<RowDataPacket[]>(
      `SELECT gateway_token_sha256 FROM panel_vpn_settings WHERE id = 1`,
    );
    stored = row?.gateway_token_sha256 ?? null;
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
  }
  if (!stored) return false;
  return safeEqual(sha256(tokenPlain), stored);
}
