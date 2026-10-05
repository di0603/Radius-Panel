import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { intToIpv4, ipv4OrCidrBounds } from '../lib/ipv4.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Lista global de destinos permitidos a los perfiles restringidos
 * (lan_restricted e internet_lan_restricted): una unica lista compartida por
 * los dos. Cada entrada es destino (IPv4 o CIDR dentro de la LAN) + protocolo
 * (tcp/udp/icmp) + puertos + comentario. Se valida campo a campo con formatos
 * cerrados: nada de texto libre llega a una regla nft (el comentario solo se
 * escribe, saneado, en una linea `#` aparte; ver vpnProfilesNft.ts).
 */

export const RESTRICTED_PROTOCOLS = ['tcp', 'udp', 'icmp'] as const;
export type RestrictedProtocol = (typeof RESTRICTED_PROTOCOLS)[number];

export const MAX_RESTRICTED_ENTRIES = 200;
const MAX_PORT_TOKENS = 16;

export interface RestrictedDestination {
  id: number;
  destCidr: string;
  protocol: RestrictedProtocol;
  /** Lista normalizada "22,443,8000-8100"; `null` = todos los puertos (siempre `null` con icmp). */
  ports: string | null;
  comment: string;
}

export interface RestrictedDestinationInput {
  destCidr: string;
  protocol: RestrictedProtocol;
  ports?: string | null;
  comment?: string | null;
}

export type NormalizedRestrictedInput = Omit<RestrictedDestination, 'id'>;

/** "22, 443,8000-8100" -> "22,443,8000-8100". Lanza badRequest si algo no es un puerto o rango valido. */
export function normalizePorts(raw: string): string {
  const tokens = raw.split(',').map((t) => t.trim());
  if (tokens.length > MAX_PORT_TOKENS) {
    throw badRequest(`Demasiados puertos (maximo ${MAX_PORT_TOKENS} entradas separadas por comas)`);
  }
  const normalized = tokens.map((token) => {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(token);
    if (!match) throw badRequest(`Puerto o rango invalido: "${token}" (usa 22 o 8000-8100)`);
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || from > 65535 || to < 1 || to > 65535) {
      throw badRequest(`Puerto fuera de 1-65535: "${token}"`);
    }
    if (to < from) throw badRequest(`Rango de puertos al reves: "${token}"`);
    return from === to ? String(from) : `${from}-${to}`;
  });
  return normalized.join(',');
}

/** Destino en forma canonica (sin ceros a la izquierda ni bits de host) y dentro de la LAN. */
function normalizeDestination(raw: string, lanCidr: string): string {
  const value = raw.trim();
  const bounds = ipv4OrCidrBounds(value);
  if (!bounds) throw badRequest('El destino debe ser una IPv4 (1.2.3.4) o un CIDR (1.2.3.0/24)');
  if (!bounds.canonical) {
    throw badRequest(
      `El CIDR tiene bits de host: usa la forma canonica (${intToIpv4(bounds.start)}/${value.split('/')[1]})`,
    );
  }
  const prefix = value.includes('/') ? `/${value.split('/')[1]}` : '';
  if (`${intToIpv4(bounds.start)}${prefix}` !== value) {
    throw badRequest('Direccion mal formada (sin ceros a la izquierda en los octetos)');
  }
  const lan = ipv4OrCidrBounds(lanCidr);
  if (!lan || bounds.start < lan.start || bounds.end > lan.end) {
    throw badRequest(
      `El destino debe estar dentro de la LAN (${lanCidr}): la lista no abre Internet`,
    );
  }
  return value;
}

/**
 * Valida y normaliza una entrada. Pura (recibe la LAN), para probarla sin
 * base de datos. icmp no admite puertos; tcp/udp sin puertos = todos.
 */
export function validateRestrictedEntry(
  input: RestrictedDestinationInput,
  lanCidr: string,
): NormalizedRestrictedInput {
  if (!(RESTRICTED_PROTOCOLS as readonly string[]).includes(input.protocol)) {
    throw badRequest('El protocolo debe ser tcp, udp o icmp');
  }
  const destCidr = normalizeDestination(String(input.destCidr ?? ''), lanCidr);

  const rawPorts = input.ports?.trim() ?? '';
  let ports: string | null = null;
  if (rawPorts) {
    if (input.protocol === 'icmp') throw badRequest('icmp no admite puertos');
    ports = normalizePorts(rawPorts);
  }

  const comment = (input.comment ?? '').trim();
  if (comment.length > 128) throw badRequest('El comentario admite hasta 128 caracteres');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(comment)) {
    throw badRequest('El comentario no puede llevar saltos de linea ni caracteres de control');
  }

  return { destCidr, protocol: input.protocol, ports, comment };
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

function toEntry(row: RowDataPacket): RestrictedDestination {
  return {
    id: Number(row.id),
    destCidr: String(row.dest_cidr),
    protocol: row.protocol as RestrictedProtocol,
    ports: row.ports ?? null,
    comment: String(row.comment ?? ''),
  };
}

export async function listRestrictedDestinations(): Promise<RestrictedDestination[]> {
  try {
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT id, dest_cidr, protocol, ports, comment FROM panel_vpn_restricted_destinations ORDER BY id`,
    );
    return rows.map(toEntry);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

function sameEntry(a: NormalizedRestrictedInput, b: NormalizedRestrictedInput): boolean {
  return a.destCidr === b.destCidr && a.protocol === b.protocol && a.ports === b.ports;
}

export async function addRestrictedDestination(
  input: RestrictedDestinationInput,
  createdBy: number | null,
): Promise<RestrictedDestination> {
  const settings = await getVpnSettings();
  const entry = validateRestrictedEntry(input, settings.lanCidr);
  const existing = await listRestrictedDestinations();
  if (existing.length >= MAX_RESTRICTED_ENTRIES) {
    throw badRequest(`La lista admite hasta ${MAX_RESTRICTED_ENTRIES} entradas`);
  }
  if (existing.some((e) => sameEntry(e, entry))) throw conflict('Esa entrada ya esta en la lista');

  const [result] = await panelPool.query<ResultSetHeader>(
    `INSERT INTO panel_vpn_restricted_destinations (dest_cidr, protocol, ports, comment, created_by)
     VALUES (:destCidr, :protocol, :ports, :comment, :createdBy)`,
    { ...entry, createdBy },
  );
  return { id: result.insertId, ...entry };
}

export async function updateRestrictedDestination(
  id: number,
  input: RestrictedDestinationInput,
): Promise<{ before: RestrictedDestination; after: RestrictedDestination }> {
  const settings = await getVpnSettings();
  const entry = validateRestrictedEntry(input, settings.lanCidr);
  const existing = await listRestrictedDestinations();
  const before = existing.find((e) => e.id === id);
  if (!before) throw notFound('No existe esa entrada de la lista');
  if (existing.some((e) => e.id !== id && sameEntry(e, entry))) {
    throw conflict('Esa entrada ya esta en la lista');
  }
  await panelPool.query(
    `UPDATE panel_vpn_restricted_destinations
        SET dest_cidr = :destCidr, protocol = :protocol, ports = :ports, comment = :comment
      WHERE id = :id`,
    { ...entry, id },
  );
  return { before, after: { id, ...entry } };
}

export async function deleteRestrictedDestination(id: number): Promise<RestrictedDestination> {
  const before = (await listRestrictedDestinations()).find((e) => e.id === id);
  if (!before) throw notFound('No existe esa entrada de la lista');
  await panelPool.query(`DELETE FROM panel_vpn_restricted_destinations WHERE id = :id`, { id });
  return before;
}
