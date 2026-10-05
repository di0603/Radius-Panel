import { config } from '../config.js';
import { isValidIpv4 } from '../lib/ipv4.js';
import { PRIVATE_RANGES, RADIUS_HOST } from './vpnFirewall.js';
import {
  ACCESS_PROFILES,
  RESERVED_HOSTS,
  dhcpFromConfig,
  getProfileRanges,
  validateProfileRanges,
  type AccessProfile,
  type ProfileRanges,
} from './vpnAccessProfiles.js';
import {
  listRestrictedDestinations,
  validateRestrictedEntry,
  type RestrictedDestination,
} from './vpnRestrictedList.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Generador de vpn-profiles.nft (prompt 12.14): las reglas que IMPONEN los
 * perfiles de acceso en la VM VPN (192.168.10.29), a partir de los rangos de
 * IP por perfil y de la lista restringida. Es una tabla PROPIA
 * (`inet vpn_profiles`) pensada para incluirse desde el /etc/nftables.conf
 * existente (`include "/etc/nftables.d/vpn-profiles.nft"`): nunca lo
 * sustituye. Lo descarga un admin desde el panel y lo aplica a mano
 * deploy/vpn-gateway-apply-profiles.sh; el panel no lo ejecuta en ningun
 * sitio.
 *
 * Todo lo que entra en una regla sale de valores ya validados y en formatos
 * cerrados (IPv4/CIDR canonicos, enteros de puerto, nombre de interfaz por
 * regex); se vuelven a validar aqui por si alguien llama al generador sin
 * pasar por las rutas. El unico texto libre (el comentario de cada entrada de
 * la lista) solo se escribe saneado, en una linea `#` aparte.
 */

/** La VM VPN: destino de la cadena `input` (SSH incluido) para los perfiles de LAN completa. */
export const GATEWAY_HOST = '192.168.10.29';

export interface ProfilesRulesetInput {
  ranges: ProfileRanges;
  destinations: RestrictedDestination[];
  lanCidr: string;
  estPort: number;
  /** Interfaz de salida a Internet; si se define, las reglas "internet" tambien exigen `oifname`. */
  egressInterface?: string | null;
  /** Fecha de la cabecera (inyectable para que los golden files sean estables). */
  generatedAt: Date;
}

const IFACE_RE = /^[A-Za-z0-9_.-]{1,15}$/;

function setName(profile: AccessProfile): string {
  return `${profile}_ips`;
}

function rangeElement(start: string, end: string): string {
  return start === end ? start : `${start}-${end}`;
}

function sanitizeComment(comment: string): string {
  return comment.replace(/[^A-Za-z0-9 ._:/()+,-]/g, '?').slice(0, 80);
}

function renderSet(name: string, elements: string[]): string {
  const lines = [`\tset ${name} {`, '\t\ttype ipv4_addr', '\t\tflags interval'];
  if (elements.length) lines.push(`\t\telements = { ${elements.join(', ')} }`);
  lines.push('\t}');
  return lines.join('\n');
}

function renderRestrictedRule(entry: RestrictedDestination): string[] {
  const lines: string[] = [];
  const note = sanitizeComment(entry.comment);
  if (note) lines.push(`\t\t# ${note}`);
  if (entry.protocol === 'icmp') {
    lines.push(`\t\tip daddr ${entry.destCidr} ip protocol icmp accept`);
  } else if (entry.ports) {
    const ports = entry.ports.split(',');
    const list = ports.length === 1 ? ports[0]! : `{ ${ports.join(', ')} }`;
    lines.push(`\t\tip daddr ${entry.destCidr} ${entry.protocol} dport ${list} accept`);
  } else {
    lines.push(`\t\tip daddr ${entry.destCidr} ip protocol ${entry.protocol} accept`);
  }
  return lines;
}

/**
 * Construye el .nft completo. Pura (sin base de datos). Lanza `Error` si los
 * rangos, la lista o los parametros no pasan la validacion.
 */
export function buildProfilesRuleset(input: ProfilesRulesetInput): string {
  const problems = validateProfileRanges(input.ranges, {
    lanCidr: input.lanCidr,
    dhcp: dhcpFromConfig(),
    reservedIps: RESERVED_HOSTS,
  });
  if (problems.length) throw new Error(`Rangos de perfil invalidos: ${problems.join('; ')}`);
  for (const entry of input.destinations) {
    validateRestrictedEntry(
      {
        destCidr: entry.destCidr,
        protocol: entry.protocol,
        ports: entry.ports,
        comment: entry.comment,
      },
      input.lanCidr,
    );
  }
  if (!Number.isInteger(input.estPort) || input.estPort < 1 || input.estPort > 65535) {
    throw new Error('Puerto EST invalido');
  }
  if (!isValidIpv4(RADIUS_HOST) || !isValidIpv4(GATEWAY_HOST))
    throw new Error('IP de infraestructura invalida');
  const egress = input.egressInterface ?? null;
  if (egress !== null && !IFACE_RE.test(egress))
    throw new Error('Nombre de interfaz de salida invalido');
  const oif = egress ? ` oifname "${egress}"` : '';

  const rangeOf = (profile: AccessProfile): string[] => {
    const r = input.ranges[profile];
    return r.rangeStart && r.rangeEnd ? [rangeElement(r.rangeStart, r.rangeEnd)] : [];
  };

  const sets = [
    ...ACCESS_PROFILES.map((profile) => renderSet(setName(profile), rangeOf(profile))),
    renderSet(
      'vpn_all_ips',
      ACCESS_PROFILES.flatMap((profile) => rangeOf(profile)),
    ),
  ].join('\n\n');

  const restricted = input.destinations.flatMap(renderRestrictedRule);
  const privateSet = `{ ${PRIVATE_RANGES.join(', ')} }`;
  const lan = input.lanCidr;

  return `#!/usr/sbin/nft -f
# Generado por Radius Panel (VPN -> Perfiles de acceso) - NO EDITAR A MANO
# Reglas de los perfiles de acceso de la VPN. Se incluye desde el
# /etc/nftables.conf existente (include "/etc/nftables.d/vpn-profiles.nft");
# NO lo sustituye. Aplicar con deploy/vpn-gateway-apply-profiles.sh.
# Generado: ${input.generatedAt.toISOString()}
#
# Esta tabla (inet vpn_profiles) decide sobre el trafico que entra O sale de
# un rango de perfil y deja pasar todo lo demas. Si ademas esta cargada la
# tabla inet vpn_clients de deploy/vpn-gateway-agent (permisos por
# dispositivo), un paquete tiene que pasar las DOS: retirala o vacia esas
# reglas, o los perfiles de LAN completa seguiran bloqueando .28 y .30.

# Idempotente: se declara vacia y se borra para que el "delete" no falle la
# primera vez; todo va en el mismo "nft -f" (transaccion unica), asi que
# nunca hay una ventana sin tabla cargada.
table inet vpn_profiles {}
delete table inet vpn_profiles

table inet vpn_profiles {
${sets}

\t# Destinos permitidos a los perfiles restringidos (lista global del panel).
\tchain restricted_allow {
${restricted.length ? restricted.join('\n') : '\t\t# (lista vacia: los perfiles restringidos solo llegan a EST)'}
\t}

\tchain forward {
\t\ttype filter hook forward priority filter; policy accept;

\t\t# Solo se decide sobre trafico que toca un rango de perfil; el resto sigue
\t\t# su curso (policy accept) sin mirarlo.
\t\tip saddr != @vpn_all_ips ip daddr != @vpn_all_ips return

\t\tct state invalid counter drop
\t\tct state established,related accept

\t\t# Alta y renovacion EST (RADIUS/CA en .28): permitido a todos los perfiles.
\t\tip saddr @vpn_all_ips ip daddr ${RADIUS_HOST} tcp dport ${input.estPort} accept

\t\t# lan_full: toda la LAN (incluidas .28, .29 y .30), sin Internet.
\t\tip saddr @lan_full_ips ip daddr ${lan} accept

\t\t# internet_lan_full: toda la LAN + Internet.
\t\tip saddr @internet_lan_full_ips ip daddr ${lan} accept
\t\tip saddr @internet_lan_full_ips ip daddr != ${privateSet}${oif} accept

\t\t# lan_restricted: solo la lista; sin Internet.
\t\tip saddr @lan_restricted_ips jump restricted_allow

\t\t# internet_lan_restricted: la lista + Internet.
\t\tip saddr @internet_lan_restricted_ips jump restricted_allow
\t\tip saddr @internet_lan_restricted_ips ip daddr != ${privateSet}${oif} accept

\t\t# internet_only: solo Internet (nada de LAN ni de otras redes privadas).
\t\tip saddr @internet_only_ips ip daddr != ${privateSet}${oif} accept

\t\t# Todo lo demas, con contador (nft list chain inet vpn_profiles forward).
\t\tcounter drop
\t}

\t# Trafico dirigido a la propia VM VPN desde un cliente: solo los perfiles de
\t# LAN completa (SSH incluido).
\tchain input {
\t\ttype filter hook input priority filter; policy accept;

\t\tip saddr != @vpn_all_ips return

\t\tct state invalid counter drop
\t\tct state established,related accept
\t\tip saddr @lan_full_ips ip daddr ${GATEWAY_HOST} accept
\t\tip saddr @internet_lan_full_ips ip daddr ${GATEWAY_HOST} accept
\t\tcounter drop
\t}
}
`;
}

/** GET /api/vpn-profiles/nft: fichero completo a partir del estado actual del panel. */
export async function generateProfilesConfig(): Promise<string> {
  const [ranges, destinations, settings] = await Promise.all([
    getProfileRanges(),
    listRestrictedDestinations(),
    getVpnSettings(),
  ]);
  return buildProfilesRuleset({
    ranges,
    destinations,
    lanCidr: settings.lanCidr,
    estPort: config.est.port,
    egressInterface: config.vpnProfiles.egressInterface ?? null,
    generatedAt: new Date(),
  });
}
