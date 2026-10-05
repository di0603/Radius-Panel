import type { RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { config } from '../config.js';
import { badRequest, conflict } from '../lib/http.js';
import { intToIpv4, ipv4OrCidrBounds, ipv4ToInt, isValidIpv4 } from '../lib/ipv4.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Perfiles de acceso por dispositivo VPN (prompt 12.14) y sus rangos de IP.
 * Cada perfil tiene un rango (inicio-fin) dentro de la LAN: la IP fija
 * (Framed-IP-Address) de un dispositivo sale siempre del rango de SU perfil, y
 * el fichero nftables generado (vpnProfilesNft.ts) impone el perfil por esa
 * IP. Ver sql/panel-schema-vpn-profiles.sql.
 */

export const ACCESS_PROFILES = [
  'lan_restricted',
  'lan_full',
  'internet_only',
  'internet_lan_restricted',
  'internet_lan_full',
] as const;
export type AccessProfile = (typeof ACCESS_PROFILES)[number];

/** Perfil de las altas nuevas (el mas cerrado que aun deja usar la VPN). */
export const DEFAULT_ACCESS_PROFILE: AccessProfile = 'internet_only';
/** Perfil de los dispositivos que ya existian al aplicar la migracion (su comportamiento de antes). */
export const LEGACY_ACCESS_PROFILE: AccessProfile = 'internet_lan_full';

export function isAccessProfile(value: unknown): value is AccessProfile {
  return typeof value === 'string' && (ACCESS_PROFILES as readonly string[]).includes(value);
}

export interface AccessProfileInfo {
  profile: AccessProfile;
  label: string;
  description: string;
  internet: boolean;
  lan: 'none' | 'restricted' | 'full';
  /** Acceso a infraestructura (CA, RADIUS, BD y la propia VM VPN): el panel lo avisa en rojo. */
  infrastructureAccess: boolean;
}

export const ACCESS_PROFILE_INFO: Record<AccessProfile, AccessProfileInfo> = {
  lan_restricted: {
    profile: 'lan_restricted',
    label: 'LAN restringida',
    description:
      'Sin Internet por el tunel. En la LAN solo llega a los destinos y puertos de la lista restringida.',
    internet: false,
    lan: 'restricted',
    infrastructureAccess: false,
  },
  lan_full: {
    profile: 'lan_full',
    label: 'LAN completa',
    description:
      'Sin Internet por el tunel. Acceso a TODA la LAN 192.168.10.0/24, todos los puertos.',
    internet: false,
    lan: 'full',
    infrastructureAccess: true,
  },
  internet_only: {
    profile: 'internet_only',
    label: 'Solo Internet',
    description: 'Todo el trafico de Internet por el tunel. Sin acceso a la LAN.',
    internet: true,
    lan: 'none',
    infrastructureAccess: false,
  },
  internet_lan_restricted: {
    profile: 'internet_lan_restricted',
    label: 'Internet + LAN restringida',
    description:
      'Internet por el tunel. En la LAN solo llega a los destinos y puertos de la lista restringida.',
    internet: true,
    lan: 'restricted',
    infrastructureAccess: false,
  },
  internet_lan_full: {
    profile: 'internet_lan_full',
    label: 'Internet + LAN completa',
    description: 'Internet por el tunel y acceso a TODA la LAN 192.168.10.0/24, todos los puertos.',
    internet: true,
    lan: 'full',
    infrastructureAccess: true,
  },
};

/** Texto del aviso rojo que muestra el panel en los perfiles con acceso a infraestructura. */
export const INFRASTRUCTURE_WARNING = 'acceso a infraestructura: CA, RADIUS y BD';

/** IPs de infraestructura que ningun rango de perfil puede contener (arquitectura de la VPN, CLAUDE.md). */
export const RESERVED_HOSTS = ['192.168.10.28', '192.168.10.29', '192.168.10.30'];

export type ProfileRanges = Record<
  AccessProfile,
  { rangeStart: string | null; rangeEnd: string | null }
>;

export function emptyRanges(): ProfileRanges {
  return Object.fromEntries(
    ACCESS_PROFILES.map((p) => [p, { rangeStart: null, rangeEnd: null }]),
  ) as ProfileRanges;
}

export interface RangeValidationContext {
  /** Red local (CIDR) dentro de la que tienen que estar todos los rangos. */
  lanCidr: string;
  /** Rango DHCP del router, si se conoce (VPN_DHCP_START/END). */
  dhcp?: { start: string; end: string } | null;
  /** IPs fijas conocidas que ningun rango puede contener (infraestructura). */
  reservedIps?: string[];
  /** Dispositivos con IP asignada: su IP tiene que seguir dentro del rango de su perfil. */
  devices?: { username: string; profile: AccessProfile; ip: string }[];
}

/**
 * Valida un conjunto completo de rangos (uno por perfil, o sin rango) y
 * devuelve la lista de problemas en espanol; vacia = valido. Pura: la usan la
 * ruta, el generador y los tests sin tocar la base de datos.
 *
 * Reglas: inicio<=fin, IPv4 validas, dentro de la LAN (sin la direccion de red
 * ni la de broadcast), sin pisar el DHCP del router ni las IPs reservadas
 * (.28, .29 y .30), sin solaparse entre perfiles, y sin dejar fuera del rango
 * de su perfil la IP de ningun dispositivo existente.
 */
export function validateProfileRanges(
  ranges: ProfileRanges,
  ctx: RangeValidationContext,
): string[] {
  const problems: string[] = [];
  const lan = ipv4OrCidrBounds(ctx.lanCidr);
  if (!lan) return [`La red local configurada (${ctx.lanCidr}) no es un CIDR valido`];
  const reserved = ctx.reservedIps ?? RESERVED_HOSTS;
  const dhcp =
    ctx.dhcp && isValidIpv4(ctx.dhcp.start) && isValidIpv4(ctx.dhcp.end)
      ? { start: ipv4ToInt(ctx.dhcp.start), end: ipv4ToInt(ctx.dhcp.end) }
      : null;

  const parsed: { profile: AccessProfile; start: number; end: number }[] = [];
  for (const profile of ACCESS_PROFILES) {
    const { rangeStart, rangeEnd } = ranges[profile];
    if (!rangeStart && !rangeEnd) continue; // sin rango: permitido (no admite altas)
    if (!rangeStart || !rangeEnd || !isValidIpv4(rangeStart) || !isValidIpv4(rangeEnd)) {
      problems.push(`${profile}: inicio y fin deben ser dos IPv4 validas`);
      continue;
    }
    const start = ipv4ToInt(rangeStart);
    const end = ipv4ToInt(rangeEnd);
    if (start > end) {
      problems.push(`${profile}: el inicio (${rangeStart}) va despues del fin (${rangeEnd})`);
      continue;
    }
    if (start <= lan.start || end >= lan.end) {
      problems.push(
        `${profile}: el rango ${rangeStart}-${rangeEnd} tiene que estar dentro de ${ctx.lanCidr} (sin la direccion de red ni la de broadcast)`,
      );
      continue;
    }
    if (dhcp && start <= dhcp.end && end >= dhcp.start) {
      problems.push(
        `${profile}: el rango ${rangeStart}-${rangeEnd} pisa el DHCP del router (${intToIpv4(dhcp.start)}-${intToIpv4(dhcp.end)})`,
      );
      continue;
    }
    const hit = reserved.find(
      (ip) => isValidIpv4(ip) && ipv4ToInt(ip) >= start && ipv4ToInt(ip) <= end,
    );
    if (hit) {
      problems.push(
        `${profile}: el rango ${rangeStart}-${rangeEnd} incluye ${hit}, una IP fija de infraestructura`,
      );
      continue;
    }
    parsed.push({ profile, start, end });
  }

  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i]!;
      const b = parsed[j]!;
      if (a.start <= b.end && b.start <= a.end) {
        problems.push(`Los rangos de ${a.profile} y ${b.profile} se solapan`);
      }
    }
  }

  for (const device of ctx.devices ?? []) {
    const range = ranges[device.profile];
    const inRange =
      !!range.rangeStart &&
      !!range.rangeEnd &&
      isValidIpv4(device.ip) &&
      ipv4ToInt(device.ip) >= ipv4ToInt(range.rangeStart) &&
      ipv4ToInt(device.ip) <= ipv4ToInt(range.rangeEnd);
    if (!inRange) {
      problems.push(
        `El dispositivo ${device.username} (${device.profile}) tiene la IP ${device.ip}, fuera del rango de su perfil: cambia primero su perfil o libera esa IP`,
      );
    }
  }

  return problems;
}

/**
 * Primera IP libre del rango, o `null` si esta lleno. Pura. Nunca se sale del
 * rango dado: el llamador decide que hacer (error claro) si esta lleno.
 */
export function pickFreeIpInRange(
  rangeStart: string,
  rangeEnd: string,
  usedIps: Iterable<string>,
): string | null {
  const used = new Set(usedIps);
  for (let n = ipv4ToInt(rangeStart); n <= ipv4ToInt(rangeEnd); n++) {
    const ip = intToIpv4(n);
    if (!used.has(ip)) return ip;
  }
  return null;
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

export async function getProfileRanges(): Promise<ProfileRanges> {
  const ranges = emptyRanges();
  try {
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT profile, range_start, range_end FROM panel_vpn_profile_ranges`,
    );
    for (const row of rows) {
      if (isAccessProfile(row.profile)) {
        ranges[row.profile] = {
          rangeStart: row.range_start ?? null,
          rangeEnd: row.range_end ?? null,
        };
      }
    }
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return ranges;
}

/** Rango del perfil, o error claro si todavia no se ha configurado (no se asigna nunca de otro rango). */
export async function requireProfileRange(
  profile: AccessProfile,
): Promise<{ start: string; end: string }> {
  const range = (await getProfileRanges())[profile];
  if (!range.rangeStart || !range.rangeEnd) {
    throw conflict(
      `El perfil ${profile} no tiene rango de IPs configurado: definelo en VPN -> Perfiles de acceso antes de usarlo`,
    );
  }
  return { start: range.rangeStart, end: range.rangeEnd };
}

export function dhcpFromConfig(): { start: string; end: string } | null {
  const { dhcpStart, dhcpEnd } = config.vpnProfiles;
  return dhcpStart && dhcpEnd ? { start: dhcpStart, end: dhcpEnd } : null;
}

export interface SetRangesResult {
  before: ProfileRanges;
  after: ProfileRanges;
}

/**
 * Guarda los rangos de todos los perfiles (reemplazo completo, validado de
 * una vez: asi nunca hay un estado intermedio con solapes). Devuelve el
 * antes/despues para la auditoria.
 */
export async function setProfileRanges(
  next: ProfileRanges,
  updatedBy: number | null,
): Promise<SetRangesResult> {
  const [before, settings, [deviceRows]] = await Promise.all([
    getProfileRanges(),
    getVpnSettings(),
    panelPool.query<RowDataPacket[]>(
      `SELECT username, access_profile, framed_ip FROM panel_vpn_devices WHERE framed_ip IS NOT NULL`,
    ),
  ]);

  const problems = validateProfileRanges(next, {
    lanCidr: settings.lanCidr,
    dhcp: dhcpFromConfig(),
    devices: deviceRows
      .filter((r) => isAccessProfile(r.access_profile))
      .map((r) => ({
        username: String(r.username),
        profile: r.access_profile as AccessProfile,
        ip: String(r.framed_ip),
      })),
  });
  if (problems.length) throw badRequest(problems.join('; '));

  for (const profile of ACCESS_PROFILES) {
    await panelPool.query(
      `INSERT INTO panel_vpn_profile_ranges (profile, range_start, range_end, updated_by)
       VALUES (:profile, :start, :end, :by)
       ON DUPLICATE KEY UPDATE range_start = VALUES(range_start), range_end = VALUES(range_end),
                               updated_by = VALUES(updated_by)`,
      { profile, start: next[profile].rangeStart, end: next[profile].rangeEnd, by: updatedBy },
    );
  }
  return { before, after: next };
}
