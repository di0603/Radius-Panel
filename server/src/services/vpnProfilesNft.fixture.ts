import { emptyRanges } from './vpnAccessProfiles.js';
import {
  EXISTING_EST_FORWARD_LINE,
  FORWARD_LINES_TO_REMOVE,
  buildFragmentParts,
  type FragmentOptions,
} from './vpnProfilesNft.js';
import type { RestrictedDestination } from './vpnRestrictedList.js';

/**
 * nftables.conf de la .29 ANTES de integrar los perfiles, reconstruido desde la salida real de
 * `nft list ruleset` (tabla unica `inet filter`, policy drop en input y forward):
 *
 *  - input: iif lo, ct state, icmp/icmpv6, udp 500/4500 (IKE), 3799 desde la .28 y
 *    "meta ipsec missing ip saddr 192.168.10.0/24 tcp dport 22 accept" (SSH solo desde la LAN
 *    fisica). No hay drop explicito: solo la policy.
 *  - forward: ct state (invalid drop, established,related accept) y el MSS clamp, antes; la
 *    regla de EST 8443 y las TRES lineas que el fragmento hace eliminar, literales.
 *
 * Lo que NO se conoce literalmente (la sintaxis exacta del MSS clamp y de las reglas icmp/icmpv6,
 * y el orden relativo de la regla de EST y las tres lineas) esta reconstruido; las cuatro reglas de
 * forward citadas y la de SSH son las reales. `flush ruleset` al principio y el chain output son
 * suposiciones razonables (nftables.conf tipico).
 *
 * Marcadores: @@...@@ = donde entra cada parte del fragmento; "# QUITAR" = la linea siguiente es
 * una de las tres que se eliminan.
 */
export const FIXTURE_NFTABLES_CONF = `#!/usr/sbin/nft -f
flush ruleset

table inet filter {
\t# @@SETS@@

\tchain input {
\t\ttype filter hook input priority filter; policy drop;
\t\tiif lo accept
\t\tct state invalid drop
\t\tct state established,related accept
\t\tip protocol icmp accept
\t\tmeta l4proto ipv6-icmp accept
\t\tudp dport { 500, 4500 } accept
\t\tip saddr 192.168.10.28 udp dport 3799 accept
\t\tmeta ipsec missing ip saddr 192.168.10.0/24 tcp dport 22 accept
\t\t# @@INPUT@@
\t}

\tchain forward {
\t\ttype filter hook forward priority filter; policy drop;
\t\tct state invalid drop
\t\tct state established,related accept
\t\ttcp flags syn tcp option maxseg size set rt mtu
\t\t${EXISTING_EST_FORWARD_LINE}
${FORWARD_LINES_TO_REMOVE.map((l) => `\t\t# QUITAR\n\t\t${l}`).join('\n')}
\t\t# @@FORWARD@@
\t}

\tchain output {
\t\ttype filter hook output priority filter; policy accept;
\t}
}

# @@INCLUDE@@
`;

/** Lineas marcadas QUITAR: las tres de forward que hay que eliminar al integrar el fragmento. */
export function removeMarkedLines(conf: string): { conf: string; removed: string[] } {
  const lines = conf.split('\n');
  const removed: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes('# QUITAR')) {
      removed.push(lines[i + 1]!.trim());
      i++; // la regla va en la linea siguiente al comentario
      continue;
    }
    kept.push(lines[i]!);
  }
  return { conf: kept.join('\n'), removed };
}

/**
 * Monta el nftables.conf "despues": quita las tres lineas, mete las partes del
 * fragmento y, en vez del `include`, pega el contenido del fichero de sets
 * (para poder hacer `nft -c -f` sin depender de la ruta de /etc).
 */
export function assembleNftablesConf(
  options: FragmentOptions,
  setsFile: string | null,
  fixture = FIXTURE_NFTABLES_CONF,
): { conf: string; removed: string[] } {
  const parts = buildFragmentParts(options);
  const { conf, removed } = removeMarkedLines(fixture);
  const assembled = conf
    .replace('\t# @@SETS@@', parts.sets)
    .replace('\t\t# @@FORWARD@@', parts.forward)
    .replace('\t\t# @@INPUT@@', parts.input)
    .replace(
      '# @@INCLUDE@@',
      setsFile ? setsFile.replace(/^#!.*\n/, '') : '# (sin fichero de sets: sets vacios)',
    );
  return { conf: assembled, removed };
}

/** Rangos y lista de EJEMPLO (inventados), una de cada perfil. */
export const EXAMPLE_DESTINATIONS: RestrictedDestination[] = [
  {
    id: 1,
    destCidr: '192.168.10.50',
    protocol: 'tcp',
    ports: '22,443,8000-8100',
    comment: 'Ejemplo: servidor de ficheros',
  },
  {
    id: 2,
    destCidr: '192.168.10.0/28',
    protocol: 'udp',
    ports: '53',
    comment: 'Ejemplo: DNS interno',
  },
  {
    id: 3,
    destCidr: '192.168.10.60',
    protocol: 'icmp',
    ports: null,
    comment: 'Ejemplo: ping al NAS',
  },
  { id: 4, destCidr: '192.168.10.70', protocol: 'tcp', ports: null, comment: 'Ejemplo: todo tcp' },
];

export function exampleRanges() {
  const ranges = emptyRanges();
  ranges.internet_lan_full = { rangeStart: '192.168.10.75', rangeEnd: '192.168.10.99' };
  ranges.lan_restricted = { rangeStart: '192.168.10.100', rangeEnd: '192.168.10.104' };
  ranges.lan_full = { rangeStart: '192.168.10.105', rangeEnd: '192.168.10.109' };
  ranges.internet_only = { rangeStart: '192.168.10.110', rangeEnd: '192.168.10.114' };
  ranges.internet_lan_restricted = { rangeStart: '192.168.10.115', rangeEnd: '192.168.10.119' };
  return ranges;
}
