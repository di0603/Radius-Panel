import { z } from 'zod';
import type { RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { logger } from '../lib/logger.js';

/**
 * Ajustes del modulo VPN (panel_vpn_settings, fila unica id=1). Ver
 * sql/panel-schema-vpn.sql para los valores por defecto.
 */
export interface VpnSettings {
  vpnFqdn: string;
  poolStart: string;
  poolEnd: string;
  dns: string;
  deviceCertDays: number;
  renewAfterDays: number;
  overlapHours: number;
  androidCertDays: number;
}

export const DEFAULT_VPN_SETTINGS: VpnSettings = {
  vpnFqdn: 'vpn.vlc.didev.es',
  poolStart: '192.168.10.75',
  poolEnd: '192.168.10.99',
  dns: '',
  deviceCertDays: 30,
  renewAfterDays: 20,
  overlapHours: 48,
  androidCertDays: 365,
};

function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

const ipv4 = z.string().refine(isValidIpv4, 'Direccion IPv4 invalida');

/** Convierte "a.b.c.d" a un entero de 32 bits, para poder comparar rangos. */
function ipv4ToInt(ip: string): number {
  return ip
    .split('.')
    .map(Number)
    .reduce((acc, octet) => acc * 256 + octet, 0);
}

/**
 * Valida los ajustes del modulo VPN. `renewAfterDays` tiene que ser menor que
 * `deviceCertDays` (si no, la renovacion automatica dispararia despues de que
 * el certificado ya haya caducado) y `poolStart` no puede ir despues de
 * `poolEnd`.
 */
export const vpnSettingsSchema = z
  .object({
    vpnFqdn: z.string().min(1, 'vpnFqdn no puede estar vacio'),
    poolStart: ipv4,
    poolEnd: ipv4,
    dns: z.string().default(''),
    deviceCertDays: z.number().int().positive(),
    renewAfterDays: z.number().int().positive(),
    overlapHours: z.number().int().positive(),
    androidCertDays: z.number().int().positive(),
  })
  .refine((s) => s.renewAfterDays < s.deviceCertDays, {
    message: 'renewAfterDays debe ser menor que deviceCertDays',
    path: ['renewAfterDays'],
  })
  .refine((s) => ipv4ToInt(s.poolStart) <= ipv4ToInt(s.poolEnd), {
    message: 'poolStart debe ir antes (o igual) que poolEnd',
    path: ['poolStart'],
  });

/** Mapea la fila cruda de panel_vpn_settings (snake_case) a VpnSettings. */
export function parseVpnSettingsRow(row: RowDataPacket | undefined): VpnSettings {
  if (!row) return DEFAULT_VPN_SETTINGS;
  return vpnSettingsSchema.parse({
    vpnFqdn: row.vpn_fqdn,
    poolStart: row.pool_start,
    poolEnd: row.pool_end,
    dns: row.dns ?? '',
    deviceCertDays: Number(row.device_cert_days),
    renewAfterDays: Number(row.renew_after_days),
    overlapHours: Number(row.overlap_hours),
    androidCertDays: Number(row.android_cert_days),
  });
}

let warnedMissingTable = false;
function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

/**
 * La tabla es opcional (igual que panel_user_meta): sin ella el modulo VPN
 * aparece desactivado (ver /api/meta) y esta funcion se degrada a los
 * valores por defecto en vez de romper nada.
 */
export async function getVpnSettings(): Promise<VpnSettings> {
  try {
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT vpn_fqdn, pool_start, pool_end, dns, device_cert_days, renew_after_days,
              overlap_hours, android_cert_days
         FROM panel_vpn_settings WHERE id = 1`,
    );
    return parseVpnSettingsRow(rows[0]);
  } catch (err) {
    if (isMissingTable(err)) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        logger.warn(
          'panel_vpn_settings no existe: el modulo VPN usa los valores por defecto. ' +
            'Aplica sql/panel-schema-vpn.sql para activarlo.',
        );
      }
      return DEFAULT_VPN_SETTINGS;
    }
    throw err;
  }
}
