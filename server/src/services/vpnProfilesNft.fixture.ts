import { emptyRanges } from './vpnAccessProfiles.js';
import { buildFragmentParts, type FragmentOptions } from './vpnProfilesNft.js';
import type { RestrictedDestination } from './vpnRestrictedList.js';

/**
 * Stand-in de /etc/nftables.conf de la .29 para PROBAR el fragmento: una tabla
 * `inet filter` con policy drop en input y forward y unas reglas existentes
 * representativas (IKE, 3799 desde la .28, SSH solo desde la LAN fisica, MSS
 * clamp, retorno de conexiones). NO es el fichero real (no esta en el repo):
 * las lineas marcadas "QUITAR" son las dos de forward que el fragmento pide
 * eliminar, tal como se describen (drop a .28/.30 y accept generico de la
 * LAN), con el aspecto que podrian tener.
 *
 * Los marcadores @@...@@ indican donde entra cada parte del fragmento.
 */
export const FIXTURE_NFTABLES_CONF = `#!/usr/sbin/nft -f
flush ruleset

table inet filter {
\t# @@SETS@@

\tchain input {
\t\ttype filter hook input priority filter; policy drop;
\t\tct state established,related accept
\t\tct state invalid drop
\t\tiif lo accept
\t\t# IKE (strongSwan)
\t\tudp dport { 500, 4500 } accept
\t\t# CoA/Disconnect desde la .28
\t\tip saddr 192.168.10.28 udp dport 3799 accept
\t\t# SSH solo desde la LAN fisica (no desde el pool de la VPN)
\t\tip saddr 192.168.10.0/24 ip saddr != 192.168.10.70-192.168.10.129 tcp dport 22 accept
\t\t# @@INPUT@@
\t}

\tchain forward {
\t\ttype filter hook forward priority filter; policy drop;
\t\tct state established,related accept
\t\t# MSS clamp
\t\ttcp flags syn tcp option maxseg size set rt mtu
\t\t# QUITAR (1): drop de los clientes VPN hacia RADIUS/MariaDB
\t\tip saddr 192.168.10.75-192.168.10.119 ip daddr { 192.168.10.28, 192.168.10.30 } drop
\t\t# QUITAR (2): accept generico de los clientes VPN hacia toda la LAN
\t\tip saddr 192.168.10.75-192.168.10.119 ip daddr 192.168.10.0/24 accept
\t\t# @@FORWARD@@
\t}

\tchain output {
\t\ttype filter hook output priority filter; policy drop;
\t\taccept
\t}
}

# @@INCLUDE@@
`;

/** Lineas marcadas QUITAR: las dos de forward que hay que eliminar al integrar el fragmento. */
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
 * Monta el nftables.conf "despues": quita las dos lineas, mete las partes del
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
