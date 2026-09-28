import { z } from 'zod';
import type { RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { isValidIpv4, ipv4ToInt } from '../lib/ipv4.js';
import { logger } from '../lib/logger.js';

/**
 * Ajustes del modulo VPN (panel_vpn_settings, fila unica id=1). Ver
 * sql/panel-schema-vpn.sql para los valores por defecto.
 */
export interface VpnSettings {
  vpnFqdn: string;
  /** Identidad AAA que deben configurar los clientes para validar el certificado de FreeRADIUS. */
  aaaId: string;
  poolStart: string;
  poolEnd: string;
  /** Red local (CIDR) desde la que se puede usar el enlace de descarga del .p12 de Android. */
  lanCidr: string;
  dns: string;
  deviceCertDays: number;
  renewAfterDays: number;
  overlapHours: number;
  androidCertDays: number;
  /** URL del endpoint EST (RFC 7030), pendiente de implementar. */
  estUrl: string;
}

export const DEFAULT_VPN_SETTINGS: VpnSettings = {
  vpnFqdn: 'vpn.vlc.didev.es',
  aaaId: 'CN=radius.vpn.vlc.didev.es',
  poolStart: '192.168.10.75',
  poolEnd: '192.168.10.99',
  lanCidr: '192.168.10.0/24',
  dns: '',
  deviceCertDays: 30,
  renewAfterDays: 20,
  overlapHours: 48,
  androidCertDays: 365,
  estUrl: 'https://pki.vlc.didev.es:8443',
};

const ipv4 = z.string().refine(isValidIpv4, 'Direccion IPv4 invalida');
const cidr = z.string().refine((v) => {
  const [ip, prefix] = v.split('/');
  return !!ip && isValidIpv4(ip) && /^\d{1,2}$/.test(prefix ?? '') && Number(prefix) <= 32;
}, 'CIDR invalido (formato a.b.c.d/nn)');

/**
 * Valida los ajustes del modulo VPN. `renewAfterDays` tiene que ser menor que
 * `deviceCertDays` (si no, la renovacion automatica dispararia despues de que
 * el certificado ya haya caducado) y `poolStart` no puede ir despues de
 * `poolEnd`.
 */
export const vpnSettingsSchema = z
  .object({
    vpnFqdn: z.string().min(1, 'vpnFqdn no puede estar vacio'),
    aaaId: z.string().min(1, 'aaaId no puede estar vacio'),
    poolStart: ipv4,
    poolEnd: ipv4,
    lanCidr: cidr,
    dns: z.string().default(''),
    deviceCertDays: z.number().int().positive(),
    renewAfterDays: z.number().int().positive(),
    overlapHours: z.number().int().positive(),
    androidCertDays: z.number().int().positive(),
    estUrl: z.string().min(1, 'estUrl no puede estar vacio'),
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
    aaaId: row.aaa_id ?? DEFAULT_VPN_SETTINGS.aaaId,
    poolStart: row.pool_start,
    poolEnd: row.pool_end,
    lanCidr: row.lan_cidr ?? DEFAULT_VPN_SETTINGS.lanCidr,
    dns: row.dns ?? '',
    deviceCertDays: Number(row.device_cert_days),
    renewAfterDays: Number(row.renew_after_days),
    overlapHours: Number(row.overlap_hours),
    androidCertDays: Number(row.android_cert_days),
    estUrl: row.est_url ?? DEFAULT_VPN_SETTINGS.estUrl,
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
      `SELECT * FROM panel_vpn_settings WHERE id = 1`,
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
