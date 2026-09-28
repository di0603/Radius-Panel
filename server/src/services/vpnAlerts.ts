import type { RowDataPacket } from 'mysql2';
import { panelPool, radiusPool } from '../db/pools.js';
import {
  vpnAndroidExpiringGauge,
  vpnCaExpiringGauge,
  vpnEstRejectionsLastHourGauge,
  vpnRenewalFailingGauge,
} from '../lib/metrics.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Alertas de salud del modulo VPN: dispositivos cuya renovacion automatica
 * deberia haber saltado y no lo ha hecho, certificados Android o la CA
 * intermedia cerca de caducar, y un pico de rechazos EST. Se usa a la vez
 * para la tarjeta "VPN" del panel y para los Gauges de /metrics (esta misma
 * funcion los actualiza como efecto secundario al calcularlos).
 */

const ANDROID_EXPIRY_WARNING_DAYS = 30;
const CA_EXPIRY_WARNING_DAYS = 90;
const RENEWAL_CRITICAL_DAYS = 3;
/** Umbral fijo por ahora; candidato a moverse a panel_vpn_settings cuando exista la pagina de ajustes. */
const EST_REJECTIONS_THRESHOLD = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

function parseUtc(value: string): number {
  return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

export interface RenewalFailingAlert {
  username: string;
  platform: 'windows' | 'linux';
  /** `null` si el dispositivo no tiene ningun certificado activo (todavia peor que uno a punto de caducar). */
  notAfter: string | null;
  critical: boolean;
}

export interface AndroidExpiringAlert {
  username: string;
  notAfter: string;
}

export interface CaExpiringAlert {
  id: number;
  subjectCn: string | null;
  notAfter: string;
}

export interface VpnAlerts {
  renewalFailing: RenewalFailingAlert[];
  androidExpiringSoon: AndroidExpiringAlert[];
  caExpiringSoon: CaExpiringAlert[];
  estRejectionsLastHour: number;
  estRejectionsThreshold: number;
}

const EMPTY_ALERTS: VpnAlerts = {
  renewalFailing: [],
  androidExpiringSoon: [],
  caExpiringSoon: [],
  estRejectionsLastHour: 0,
  estRejectionsThreshold: EST_REJECTIONS_THRESHOLD,
};

/**
 * panel_vpn_devices y vpn_certificates pueden vivir en servidores MySQL
 * distintos (igual que en el resto del modulo): se traen por separado y se
 * cruzan aqui, nunca con un JOIN SQL entre las dos bases.
 */
export async function getVpnAlerts(): Promise<VpnAlerts> {
  let devices: RowDataPacket[];
  try {
    [devices] = await panelPool.query<RowDataPacket[]>(
      `SELECT username, platform, renew_after_days FROM panel_vpn_devices
        WHERE enabled = 1 AND platform IN ('windows', 'linux', 'android')`,
    );
  } catch (err) {
    if (isMissingTable(err)) return EMPTY_ALERTS;
    throw err;
  }

  const usernames = devices.map((d) => String(d.username));
  let certs: RowDataPacket[] = [];
  if (usernames.length) {
    [certs] = await radiusPool.query<RowDataPacket[]>(
      `SELECT username, not_before, not_after FROM vpn_certificates WHERE status = 'active' AND username IN (?)`,
      [usernames],
    );
  }
  const activeCertByUsername = new Map(certs.map((c) => [String(c.username), c]));

  const settings = await getVpnSettings();
  const now = Date.now();
  const renewalFailing: RenewalFailingAlert[] = [];
  const androidExpiringSoon: AndroidExpiringAlert[] = [];

  for (const device of devices) {
    const username = String(device.username);
    const cert = activeCertByUsername.get(username);

    if (device.platform === 'android') {
      if (cert && parseUtc(String(cert.not_after)) - now < ANDROID_EXPIRY_WARNING_DAYS * DAY_MS) {
        androidExpiringSoon.push({ username, notAfter: String(cert.not_after) });
      }
      continue;
    }

    const platform = device.platform as 'windows' | 'linux';
    if (!cert) {
      renewalFailing.push({ username, platform, notAfter: null, critical: true });
      continue;
    }
    const renewAfterDays = device.renew_after_days ?? settings.renewAfterDays;
    const notBefore = parseUtc(String(cert.not_before));
    const notAfter = parseUtc(String(cert.not_after));
    const renewDue = now >= notBefore + renewAfterDays * DAY_MS;
    if (renewDue) {
      renewalFailing.push({
        username,
        platform,
        notAfter: String(cert.not_after),
        critical: notAfter - now < RENEWAL_CRITICAL_DAYS * DAY_MS,
      });
    }
  }

  let caRows: RowDataPacket[] = [];
  try {
    [caRows] = await panelPool.query<RowDataPacket[]>(
      `SELECT id, subject, not_after FROM panel_pki_ca
        WHERE status IN ('active', 'retiring') AND not_after IS NOT NULL
          AND not_after < DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${CA_EXPIRY_WARNING_DAYS} DAY)`,
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  const caExpiringSoon: CaExpiringAlert[] = caRows.map((r) => ({
    id: Number(r.id),
    subjectCn: r.subject ?? null,
    notAfter: String(r.not_after),
  }));

  let estRejectionsLastHour = 0;
  try {
    const [[row]] = await panelPool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM panel_audit_log
        WHERE action = 'reject'
          AND entity IN ('vpn_est_simpleenroll', 'vpn_est_simplereenroll', 'vpn_est_status')
          AND created_at > (UTC_TIMESTAMP() - INTERVAL 1 HOUR)`,
    );
    estRejectionsLastHour = Number(row?.n ?? 0);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }

  const criticalCount = renewalFailing.filter((a) => a.critical).length;
  vpnRenewalFailingGauge.set({ severity: 'critical' }, criticalCount);
  vpnRenewalFailingGauge.set({ severity: 'warning' }, renewalFailing.length - criticalCount);
  vpnAndroidExpiringGauge.set(androidExpiringSoon.length);
  vpnCaExpiringGauge.set(caExpiringSoon.length);
  vpnEstRejectionsLastHourGauge.set(estRejectionsLastHour);

  return {
    renewalFailing,
    androidExpiringSoon,
    caExpiringSoon,
    estRejectionsLastHour,
    estRejectionsThreshold: EST_REJECTIONS_THRESHOLD,
  };
}
