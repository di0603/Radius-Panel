import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { badRequest, notFound } from '../lib/http.js';
import { isValidIpv4OrCidr } from '../lib/ipv4.js';
import type { DeviceRuleKind, DeviceRuleProtocol } from './vpnFirewall.js';

/**
 * Permisos de red por dispositivo (`panel_vpn_device_rules`), para el
 * firewall de la VM VPN (ver services/vpnFirewall.ts). El acceso a EST y el
 * bloqueo de RADIUS/MariaDB no son reglas de esta tabla: se aplican siempre
 * al generar el fichero.
 */

export interface DeviceRuleSummary {
  id: number;
  kind: DeviceRuleKind;
  destCidr: string | null;
  protocol: DeviceRuleProtocol | null;
  port: number | null;
  createdAt: string;
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

export async function listDeviceRules(username: string): Promise<DeviceRuleSummary[]> {
  try {
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT id, kind, dest_cidr, protocol, port, created_at
         FROM panel_vpn_device_rules WHERE username = :u ORDER BY id`,
      { u: username },
    );
    return rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      destCidr: r.dest_cidr ?? null,
      protocol: r.protocol ?? null,
      port: r.port === null ? null : Number(r.port),
      createdAt: r.created_at,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export interface AddDeviceRuleInput {
  kind: DeviceRuleKind;
  destCidr?: string | null;
  protocol?: DeviceRuleProtocol | null;
  port?: number | null;
}

/**
 * Anade un permiso. "internet"/"lan" no llevan destino propio (ignoran
 * destCidr/protocol/port si se mandan); "custom" exige un destCidr valido
 * (IP o CIDR) y, si lleva puerto, un protocolo tcp/udp (no tiene sentido un
 * puerto sin protocolo, ni con protocolo "any").
 */
export async function addDeviceRule(
  username: string,
  input: AddDeviceRuleInput,
  createdBy: number | null,
): Promise<DeviceRuleSummary> {
  const [[device]] = await panelPool.query<RowDataPacket[]>(
    `SELECT username FROM panel_vpn_devices WHERE username = :u`,
    { u: username },
  );
  if (!device) throw notFound(`No existe el dispositivo "${username}"`);

  let destCidr: string | null = null;
  let protocol: DeviceRuleProtocol | null = null;
  let port: number | null = null;

  if (input.kind === 'custom') {
    if (!input.destCidr || !isValidIpv4OrCidr(input.destCidr)) {
      throw badRequest('destCidr debe ser una IPv4 o un CIDR valido (p.ej. 1.2.3.4 o 1.2.3.0/24)');
    }
    destCidr = input.destCidr;
    protocol = input.protocol ?? null;
    if (input.port) {
      if (protocol !== 'tcp' && protocol !== 'udp') {
        throw badRequest('Un puerto concreto exige protocolo tcp o udp');
      }
      port = input.port;
    }
  }

  const [result] = await panelPool.query<ResultSetHeader>(
    `INSERT INTO panel_vpn_device_rules (username, kind, dest_cidr, protocol, port, created_by)
     VALUES (:u, :kind, :destCidr, :protocol, :port, :createdBy)`,
    { u: username, kind: input.kind, destCidr, protocol, port, createdBy },
  );

  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT id, kind, dest_cidr, protocol, port, created_at FROM panel_vpn_device_rules WHERE id = :id`,
    { id: result.insertId },
  );
  return {
    id: Number(row.id),
    kind: row.kind,
    destCidr: row.dest_cidr ?? null,
    protocol: row.protocol ?? null,
    port: row.port === null ? null : Number(row.port),
    createdAt: row.created_at,
  };
}

export async function deleteDeviceRule(username: string, ruleId: number): Promise<void> {
  const [result] = await panelPool.query<ResultSetHeader>(
    `DELETE FROM panel_vpn_device_rules WHERE id = :id AND username = :u`,
    { id: ruleId, u: username },
  );
  if (!result.affectedRows) throw notFound('No existe ese permiso para este dispositivo');
}
