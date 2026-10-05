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
  entriesOverlap,
  listRestrictedDestinations,
  validateRestrictedEntry,
  type RestrictedDestination,
} from './vpnRestrictedList.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Perfiles de acceso VPN en nftables (prompt 12.14, diseno v2).
 *
 * En la .29 solo existe la tabla `inet filter` (input/forward/output con
 * `policy drop` en input y forward): un `accept` en OTRA tabla no anula el
 * drop de esa, asi que los perfiles no pueden vivir en una tabla propia.
 * Por eso el trabajo se reparte en dos ficheros:
 *
 *  1. FRAGMENTO de /etc/nftables.conf (`buildNftablesFragment`): declara los
 *     sets VACIOS dentro de `inet filter` y las reglas FIJAS de forward e
 *     input que los usan. Se revisa y se integra a mano una vez; no cambia
 *     cuando cambian los rangos o la lista. Con los sets vacios no se acepta
 *     nada de la VPN (falla cerrando: lo demas cae en la policy drop).
 *  2. FICHERO DE SETS (`buildSetsFile`): SOLO `flush set` + `add element` de
 *     esos sets (en una sola carga atomica de `nft -f`). Es lo que cambia con
 *     los rangos y la lista y lo que aplica deploy/vpn-gateway-apply-profiles.sh.
 *
 * Todo lo que entra en una regla o elemento sale de valores ya validados y de
 * formatos cerrados (IPv4/CIDR canonicos, enteros de puerto, nombre de
 * interfaz por regex); se vuelven a validar aqui por si alguien llama al
 * generador sin pasar por las rutas. El comentario de cada entrada de la
 * lista (unico texto libre) no se escribe en ninguno de los dos ficheros.
 */

export const FILTER_FAMILY = 'inet';
export const FILTER_TABLE = 'filter';

/** La VM VPN: destino del accept de la cadena `input` (SSH incluido) de los perfiles de LAN completa. */
export const GATEWAY_HOST = '192.168.10.29';

/** Fichero que incluye /etc/nftables.conf (y que instala el script) con los sets rellenos. */
export const SETS_FILE_INSTALL_PATH = '/etc/nftables.d/vpn-profiles.nft';

/** Un set `interval ipv4_addr` por perfil. */
export const PROFILE_SET: Record<AccessProfile, string> = {
  lan_restricted: 'vpn_lan_restricted_ips',
  lan_full: 'vpn_lan_full_ips',
  internet_only: 'vpn_internet_only_ips',
  internet_lan_restricted: 'vpn_internet_lan_restricted_ips',
  internet_lan_full: 'vpn_internet_lan_full_ips',
};
/** Destinos permitidos a los restringidos para tcp/udp: (ipv4_addr . inet_proto . inet_service), con intervalos. */
export const RESTRICTED_DESTS_SET = 'vpn_restricted_dests';
/**
 * Destinos permitidos a los restringidos para icmp: set aparte porque `th dport`
 * en un paquete ICMP lee los bytes del checksum, no un puerto, y no se puede
 * meter icmp en la misma clave concatenada de forma fiable.
 */
export const RESTRICTED_ICMP_SET = 'vpn_restricted_icmp';

export const ALL_SET_NAMES: string[] = [
  ...ACCESS_PROFILES.map((p) => PROFILE_SET[p]),
  RESTRICTED_DESTS_SET,
  RESTRICTED_ICMP_SET,
];

const IFACE_RE = /^[A-Za-z0-9_.-]{1,15}$/;

/**
 * Lineas REALES de `chain forward` de la tabla `inet filter` de la .29 (salida de
 * `nft list ruleset`) que hay que ELIMINAR al integrar el fragmento: las tres, y solo ellas.
 * Las dos primeras de abajo (accept de Internet y accept de toda la LAN) las sustituyen
 * las reglas por set del fragmento; la primera (drop a .28/.30) impediria a lan_full e
 * internet_lan_full llegar a RADIUS y MariaDB.
 */
export const FORWARD_LINES_TO_REMOVE = [
  'meta ipsec exists ip daddr { 192.168.10.28, 192.168.10.30 } drop',
  'meta ipsec exists ip saddr 192.168.10.0/24 ip daddr != 192.168.10.0/24 accept',
  'meta ipsec exists ip saddr 192.168.10.0/24 ip daddr 192.168.10.0/24 accept',
] as const;

/**
 * Regla EXISTENTE de `chain forward` (EST hacia la CA, para cualquier cliente IPsec): se queda
 * donde esta y el fragmento NO la duplica; las reglas de perfil van justo despues.
 */
export const EXISTING_EST_FORWARD_LINE =
  'meta ipsec exists ip daddr 192.168.10.28 tcp dport 8443 accept';

export interface FragmentOptions {
  lanCidr: string;
  /** Interfaz de salida a Internet; si se define, las reglas "internet" tambien exigen `oifname`. */
  egressInterface?: string | null;
}

export interface ProfilesSetsInput {
  ranges: ProfileRanges;
  destinations: RestrictedDestination[];
  lanCidr: string;
  /** Fecha de la cabecera (inyectable para que los golden files sean estables). */
  generatedAt: Date;
}

function rangeElement(start: string, end: string): string {
  return start === end ? start : `${start}-${end}`;
}

function validateFragmentOptions(options: FragmentOptions): void {
  if (!isValidIpv4(RADIUS_HOST) || !isValidIpv4(GATEWAY_HOST)) {
    throw new Error('IP de infraestructura invalida');
  }
  if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(options.lanCidr))
    throw new Error('Red local invalida');
  const egress = options.egressInterface ?? null;
  if (egress !== null && !IFACE_RE.test(egress))
    throw new Error('Nombre de interfaz de salida invalido');
}

/* ----------------------------- 1. fragmento nftables.conf ---------------------------- */

export interface NftablesFragmentParts {
  /** Dentro de `table inet filter { ... }`, antes de las cadenas. */
  sets: string;
  /** Dentro de `chain forward`, tras el `ct state established,related accept`. */
  forward: string;
  /** Dentro de `chain input`, antes del final de la cadena. */
  input: string;
  /** Linea `include` al final del fichero, DESPUES de la tabla `inet filter`. */
  include: string;
}

function setDeclaration(name: string, type: string): string {
  return [`\tset ${name} {`, `\t\ttype ${type}`, '\t\tflags interval', '\t}'].join('\n');
}

export function buildFragmentParts(options: FragmentOptions): NftablesFragmentParts {
  validateFragmentOptions(options);
  const oif = options.egressInterface ? ` oifname "${options.egressInterface}"` : '';
  const privateSet = `{ ${PRIVATE_RANGES.join(', ')} }`;
  const lan = options.lanCidr;
  const set = PROFILE_SET;

  const sets = [
    ...ACCESS_PROFILES.map((p) => setDeclaration(set[p], 'ipv4_addr')),
    setDeclaration(RESTRICTED_DESTS_SET, 'ipv4_addr . inet_proto . inet_service'),
    setDeclaration(RESTRICTED_ICMP_SET, 'ipv4_addr'),
  ].join('\n\n');

  // "meta ipsec exists": solo trafico que llega descifrado por el tunel IPsec. Sin esto, un equipo de
  // la LAN fisica que pusiera como origen la IP de un cliente VPN heredaria sus permisos.
  const ipsec = 'meta ipsec exists';

  const forward = [
    '\t\t# --- Perfiles de acceso VPN (generado por Radius Panel) ---',
    `\t\t# Justo DESPUES de la regla existente "${EXISTING_EST_FORWARD_LINE}"`,
    '\t\t# (EST: se queda donde esta, no se duplica). Sets vacios = no se acepta nada de la VPN',
    '\t\t# (lo demas cae en la policy drop).',
    '',
    `\t\t# lan_full / internet_lan_full: toda la LAN (incluidas .28, .29 y .30), todos los puertos.`,
    `\t\t${ipsec} ip saddr @${set.lan_full} ip daddr ${lan} accept`,
    `\t\t${ipsec} ip saddr @${set.internet_lan_full} ip daddr ${lan} accept`,
    '',
    '\t\t# lan_restricted / internet_lan_restricted: solo (destino, protocolo, puerto) de la lista.',
    ...(['lan_restricted', 'internet_lan_restricted'] as const).flatMap((p) => [
      `\t\t${ipsec} ip saddr @${set[p]} ip daddr . meta l4proto . th dport @${RESTRICTED_DESTS_SET} accept`,
      `\t\t${ipsec} ip saddr @${set[p]} ip protocol icmp ip daddr @${RESTRICTED_ICMP_SET} accept`,
    ]),
    '',
    '\t\t# Perfiles con Internet: todo salvo redes privadas (nada de LAN ni de otras redes internas).',
    ...(['internet_only', 'internet_lan_restricted', 'internet_lan_full'] as const).map(
      (p) => `\t\t${ipsec} ip saddr @${set[p]} ip daddr != ${privateSet}${oif} accept`,
    ),
  ].join('\n');

  const input = [
    '\t\t# --- Perfiles de acceso VPN (generado por Radius Panel) ---',
    '\t\t# Al final de la cadena, tras la regla de SSH existente (no hay drop explicito: solo la policy).',
    `\t\t# lan_full / internet_lan_full: acceso a la propia VM VPN (SSH incluido).`,
    `\t\t${ipsec} ip saddr @${set.lan_full} ip daddr ${GATEWAY_HOST} accept`,
    `\t\t${ipsec} ip saddr @${set.internet_lan_full} ip daddr ${GATEWAY_HOST} accept`,
  ].join('\n');

  const include = `include "${SETS_FILE_INSTALL_PATH}"`;
  return { sets, forward, input, include };
}

/**
 * Fragmento para REVISAR e integrar a mano en /etc/nftables.conf (nunca se
 * aplica solo): cuatro partes con su sitio. No es cargable tal cual.
 */
export function buildNftablesFragment(options: FragmentOptions, generatedAt: Date): string {
  const parts = buildFragmentParts(options);
  const remove = FORWARD_LINES_TO_REMOVE.map((l, i) => `#     (${i + 1}) ${l}`).join('\n');
  return `# FRAGMENTO PARA /etc/nftables.conf - PARA REVISAR, NO CARGAR TAL CUAL.
# Generado por Radius Panel (VPN -> Perfiles de acceso). ${generatedAt.toISOString()}
#
# En la .29 solo existe la tabla "${FILTER_FAMILY} ${FILTER_TABLE}" (policy drop en input y forward): un accept en otra
# tabla no anularia ese drop, por eso los perfiles se integran AQUI.
#
# ORDEN DE INTEGRACION (siempre en una COPIA de /etc/nftables.conf, nunca sobre el fichero vivo):
#   0. En la .29: nft --version (>= 0.9.4) y uname -r (>= 5.6): sets concatenados con intervalos.
#   1. Descargar vpn-profiles.nft del panel e instalarlo en ${SETS_FILE_INSTALL_PATH}
#      (el include de la PARTE 4 lo necesita para poder cargar la copia).
#   2. PARTE 1: pegar la declaracion de los sets dentro de "table ${FILTER_FAMILY} ${FILTER_TABLE} { ... }", antes de las cadenas.
#   3. En "chain forward" ELIMINAR estas TRES lineas literales (y solo ellas):
${remove}
#   4. En su lugar (justo despues de la regla existente
#      "${EXISTING_EST_FORWARD_LINE}", que se queda), pegar la PARTE 2.
#   5. PARTE 3: al final de "chain input", despues de la regla de SSH existente.
#   6. PARTE 4: una linea "include" al final del fichero, DESPUES de la tabla.
#   7. nft -c -f <copia>, y cargarla de una vez (nft -f es atomico: sets y reglas a la vez).
#
# NO tocar (se quedan como estan): iif lo, ct state (invalid drop, established,related accept),
# el MSS clamp, icmp/icmpv6, udp 500/4500, 3799 desde ${RADIUS_HOST}, la regla de SSH
# ("meta ipsec missing ip saddr ${options.lanCidr} tcp dport 22 accept") y la de EST 8443 hacia ${RADIUS_HOST}.
#
# Sin quitar las tres lineas: la (1) impide a lan_full/internet_lan_full llegar a .28/.30 (el drop va antes)
# y las (2) y (3) dan a TODO cliente IPsec Internet y toda la LAN antes de que se mire ningun set.
#
# Falla cerrando: con los sets vacios (arranque, reinicio antes del include, o fallo al cargar el fichero
# de sets) un cliente IPsec solo tiene lo que dejan pasar las reglas que NO se tocan (EST 8443, icmp en
# input), nada de los perfiles. Todas las reglas llevan "meta ipsec exists": solo trafico que llega por
# el tunel, no un equipo de la LAN fisica con la IP de origen de un cliente VPN.

# ===== PARTE 1: dentro de "table ${FILTER_FAMILY} ${FILTER_TABLE} {", antes de las cadenas =====
${parts.sets}

# ===== PARTE 2: dentro de "chain forward", donde estaban las tres lineas eliminadas =====
${parts.forward}

# ===== PARTE 3: dentro de "chain input", al final, tras la regla de SSH =====
${parts.input}

# ===== PARTE 4: al final de /etc/nftables.conf, fuera de la tabla =====
# Rellena los sets al arrancar (el mismo fichero que aplica deploy/vpn-gateway-apply-profiles.sh).
${parts.include}
`;
}

/* ------------------------------- 2. fichero de sets ------------------------------- */

function validateSetsInput(input: ProfilesSetsInput): void {
  const problems = validateProfileRanges(input.ranges, {
    lanCidr: input.lanCidr,
    dhcp: dhcpFromConfig(),
    reservedIps: RESERVED_HOSTS,
  });
  if (problems.length) throw new Error(`Rangos de perfil invalidos: ${problems.join('; ')}`);

  const normalized = input.destinations.map((entry) =>
    validateRestrictedEntry(
      {
        destCidr: entry.destCidr,
        protocol: entry.protocol,
        ports: entry.ports,
        comment: entry.comment,
      },
      input.lanCidr,
    ),
  );
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (entriesOverlap(normalized[i]!, normalized[j]!)) {
        throw new Error(
          `La lista restringida tiene entradas que se solapan (${normalized[i]!.destCidr} y ${normalized[j]!.destCidr}, ${normalized[i]!.protocol})`,
        );
      }
    }
  }
}

function destElements(destinations: RestrictedDestination[]): { dests: string[]; icmp: string[] } {
  const dests: string[] = [];
  const icmp: string[] = [];
  for (const entry of destinations) {
    if (entry.protocol === 'icmp') {
      icmp.push(entry.destCidr);
      continue;
    }
    const ports = entry.ports ? entry.ports.split(',') : ['1-65535'];
    for (const port of ports) dests.push(`${entry.destCidr} . ${entry.protocol} . ${port}`);
  }
  return { dests, icmp };
}

function fillSet(name: string, elements: string[]): string[] {
  const lines = [`flush set ${FILTER_FAMILY} ${FILTER_TABLE} ${name}`];
  if (elements.length) {
    lines.push(`add element ${FILTER_FAMILY} ${FILTER_TABLE} ${name} { ${elements.join(', ')} }`);
  }
  return lines;
}

/**
 * Fichero de sets: SOLO `flush set` + `add element` sobre los sets que ya
 * existen en `inet filter`. Una unica carga atomica de `nft -f`: o se cambian
 * todos los sets o ninguno. Pura (sin base de datos). Lanza `Error` si los
 * rangos o la lista no pasan la validacion.
 */
export function buildSetsFile(input: ProfilesSetsInput): string {
  validateSetsInput(input);
  const { dests, icmp } = destElements(input.destinations);

  const body = [
    ...ACCESS_PROFILES.flatMap((profile) => {
      const r = input.ranges[profile];
      return fillSet(
        PROFILE_SET[profile],
        r.rangeStart && r.rangeEnd ? [rangeElement(r.rangeStart, r.rangeEnd)] : [],
      );
    }),
    ...fillSet(RESTRICTED_DESTS_SET, dests),
    ...fillSet(RESTRICTED_ICMP_SET, icmp),
  ].join('\n');

  return `#!/usr/sbin/nft -f
# Generado por Radius Panel (VPN -> Perfiles de acceso) - NO EDITAR A MANO
# Rellena los sets de los perfiles que YA existen en "${FILTER_FAMILY} ${FILTER_TABLE}" (ver el fragmento de
# nftables.conf). Solo "flush set" + "add element": no declara tablas ni cadenas.
# Se carga en una sola transaccion (nft -f): o cambian todos los sets o ninguno.
# Aplicar con deploy/vpn-gateway-apply-profiles.sh. Generado: ${input.generatedAt.toISOString()}

${body}
`;
}

/** GET /api/vpn-profiles/nft: fichero de sets a partir del estado actual del panel. */
export async function generateProfilesConfig(): Promise<string> {
  const [ranges, destinations, settings] = await Promise.all([
    getProfileRanges(),
    listRestrictedDestinations(),
    getVpnSettings(),
  ]);
  return buildSetsFile({
    ranges,
    destinations,
    lanCidr: settings.lanCidr,
    generatedAt: new Date(),
  });
}

/** GET /api/vpn-profiles/nftables-fragment: fragmento para revisar (no depende de rangos ni lista). */
export async function generateNftablesFragment(): Promise<string> {
  const settings = await getVpnSettings();
  return buildNftablesFragment(
    {
      lanCidr: settings.lanCidr,
      egressInterface: config.vpnProfiles.egressInterface ?? null,
    },
    new Date(),
  );
}
