import type { RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { config } from '../config.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Genera el fichero nftables completo para la VM VPN (192.168.10.29): una
 * tabla `inet vpn_clients` con las reglas de reenvio de cada dispositivo
 * activo, a partir de sus permisos (`panel_vpn_device_rules`). Lo sirve
 * `GET /vpn/gateway/firewall.nft` (routes/vpnGateway.ts); lo descarga,
 * valida y aplica `deploy/vpn-gateway-agent`.
 */

/** Arquitectura de la VPN (CLAUDE.md, no cambiar): host de FreeRADIUS y de MariaDB. */
export const RADIUS_HOST = '192.168.10.28';
export const MARIADB_HOST = '192.168.10.30';

export type DeviceRuleKind = 'internet' | 'lan' | 'custom';
export type DeviceRuleProtocol = 'tcp' | 'udp' | 'any';

export interface DeviceRule {
  id: number;
  kind: DeviceRuleKind;
  destCidr: string | null;
  protocol: DeviceRuleProtocol | null;
  port: number | null;
}

export interface DeviceFirewallInput {
  username: string;
  framedIp: string;
  /** Excepcion explicita marcada por un admin (con aviso): permite lo que por defecto esta siempre prohibido. */
  allowRadiusHost: boolean;
  allowMariadbHost: boolean;
  rules: DeviceRule[];
}

function matchProtocolPort(protocol: DeviceRuleProtocol | null, port: number | null): string {
  if (protocol && protocol !== 'any') {
    return port ? `${protocol} dport ${port}` : `ip protocol ${protocol}`;
  }
  return '';
}

function ruleLine(saddr: string, daddr: string, verdict: 'accept' | 'drop', extra = ''): string {
  const parts = [`ip saddr ${saddr}`, `ip daddr ${daddr}`];
  if (extra) parts.push(extra);
  parts.push(verdict);
  return `\t\t${parts.join(' ')}`;
}

/**
 * Lineas de un dispositivo. Orden critico: el acceso a EST va primero
 * (siempre permitido), despues el bloqueo de RADIUS/MariaDB (salvo
 * excepcion), y solo despues los permisos propios del dispositivo -si
 * "internet"/"toda la LAN" fueran antes del bloqueo, incluirian tambien
 * RADIUS/MariaDB (ambos estan dentro de esa LAN) porque nftables aplica el
 * veredicto de la primera regla que hace match dentro de la cadena.
 */
function deviceLines(device: DeviceFirewallInput, estPort: number, lanCidr: string): string[] {
  const lines: string[] = [`\t\t# ${device.username} (${device.framedIp})`];

  lines.push(ruleLine(device.framedIp, RADIUS_HOST, 'accept', `tcp dport ${estPort}`));
  if (!device.allowRadiusHost) lines.push(ruleLine(device.framedIp, RADIUS_HOST, 'drop'));
  if (!device.allowMariadbHost) lines.push(ruleLine(device.framedIp, MARIADB_HOST, 'drop'));

  for (const rule of device.rules) {
    if (rule.kind === 'internet') {
      lines.push(ruleLine(device.framedIp, '0.0.0.0/0', 'accept'));
    } else if (rule.kind === 'lan') {
      lines.push(ruleLine(device.framedIp, lanCidr, 'accept'));
    } else if (rule.kind === 'custom' && rule.destCidr) {
      lines.push(ruleLine(device.framedIp, rule.destCidr, 'accept', matchProtocolPort(rule.protocol, rule.port)));
    }
  }

  return lines;
}

/**
 * Construye el .nft completo. Pura (sin acceso a la base de datos), para
 * poder probarla sin depender de MySQL. `policy drop`: solo pasa lo que
 * alguna regla permite explicitamente.
 */
export function buildFirewallRuleset(
  devices: DeviceFirewallInput[],
  options: { estPort: number; lanCidr: string },
): string {
  const body = devices
    .flatMap((d) => deviceLines(d, options.estPort, options.lanCidr))
    .join('\n');

  return `#!/usr/sbin/nft -f
# Generado por Radius Panel (GET /vpn/gateway/firewall.nft) - NO EDITAR A MANO
# Se sobrescribe en cada descarga de deploy/vpn-gateway-agent.
# Generado: ${new Date().toISOString()}

table inet vpn_clients {
\tchain forward {
\t\ttype filter hook forward priority filter; policy drop;

${body}
\t}
}
`;
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

/** Dispositivos activos (con IP asignada) y sus permisos, para generar el fichero. */
async function getActiveDevicesWithRules(): Promise<DeviceFirewallInput[]> {
  let deviceRows: RowDataPacket[];
  try {
    [deviceRows] = await panelPool.query<RowDataPacket[]>(
      `SELECT username, framed_ip, allow_radius_host, allow_mariadb_host
         FROM panel_vpn_devices
        WHERE enabled = 1 AND framed_ip IS NOT NULL
        ORDER BY username`,
    );
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
  if (!deviceRows.length) return [];

  const usernames = deviceRows.map((d) => String(d.username));
  const [ruleRows] = await panelPool.query<RowDataPacket[]>(
    `SELECT id, username, kind, dest_cidr, protocol, port
       FROM panel_vpn_device_rules WHERE username IN (?)
      ORDER BY id`,
    [usernames],
  );
  const rulesByUsername = new Map<string, DeviceRule[]>();
  for (const row of ruleRows) {
    const list = rulesByUsername.get(String(row.username)) ?? [];
    list.push({
      id: Number(row.id),
      kind: row.kind,
      destCidr: row.dest_cidr ?? null,
      protocol: row.protocol ?? null,
      port: row.port === null ? null : Number(row.port),
    });
    rulesByUsername.set(String(row.username), list);
  }

  return deviceRows.map((row) => ({
    username: String(row.username),
    framedIp: String(row.framed_ip),
    allowRadiusHost: Boolean(row.allow_radius_host),
    allowMariadbHost: Boolean(row.allow_mariadb_host),
    rules: rulesByUsername.get(String(row.username)) ?? [],
  }));
}

/** GET /vpn/gateway/firewall.nft: fichero completo a partir de todos los dispositivos activos. */
export async function generateFirewallConfig(): Promise<string> {
  const [devices, settings] = await Promise.all([getActiveDevicesWithRules(), getVpnSettings()]);
  return buildFirewallRuleset(devices, { estPort: config.est.port, lanCidr: settings.lanCidr });
}
