/** Utilidades IPv4 puras, compartidas por vpnSettings (validacion) y vpnDevices (asignacion). */

export function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Convierte "a.b.c.d" a un entero de 32 bits, para poder comparar/recorrer rangos. */
export function ipv4ToInt(ip: string): number {
  return ip
    .split('.')
    .map(Number)
    .reduce((acc, octet) => acc * 256 + octet, 0);
}

export function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** `ip` dentro de `start`..`end` (ambos inclusive), p.ej. el pool de la VPN. */
export function isIpv4InRange(ip: string, start: string, end: string): boolean {
  if (!isValidIpv4(ip) || !isValidIpv4(start) || !isValidIpv4(end)) return false;
  const n = ipv4ToInt(ip);
  return n >= ipv4ToInt(start) && n <= ipv4ToInt(end);
}

/**
 * `ip` dentro de `cidr` (p.ej. "192.168.10.0/24"). Todo por aritmetica, sin
 * operadores bit a bit: `ipv4ToInt` puede devolver valores por encima de
 * 2^31 (p.ej. 192.168.x.x), y `&`/`|` en JS los reinterpreta como enteros de
 * 32 bits con signo antes de operar.
 */
export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!rangeIp || !isValidIpv4(ip) || !isValidIpv4(rangeIp) || !Number.isInteger(prefix)) return false;
  if (prefix < 0 || prefix > 32) return false;
  const blockSize = 2 ** (32 - prefix);
  const networkStart = Math.floor(ipv4ToInt(rangeIp) / blockSize) * blockSize;
  const ipInt = ipv4ToInt(ip);
  return ipInt >= networkStart && ipInt < networkStart + blockSize;
}

/** `true` si `value` es una IPv4 suelta ("1.2.3.4") o un CIDR valido ("1.2.3.0/24"), para el destino de una regla de firewall. */
export function isValidIpv4OrCidr(value: string): boolean {
  const [ip, prefixText] = value.split('/');
  if (!ip || !isValidIpv4(ip)) return false;
  if (prefixText === undefined) return true;
  if (!/^\d{1,2}$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  return prefix >= 0 && prefix <= 32;
}

/**
 * Limites enteros (inclusive) de una IPv4 suelta o de un CIDR, o `null` si no
 * es ninguna de las dos. `canonical` es `false` cuando el CIDR trae bits de
 * host a 1 (p.ej. "192.168.10.5/24"): nftables lo rechaza o lo reinterpreta,
 * asi que quien genere reglas debe exigir la forma canonica ("192.168.10.0/24").
 */
export function ipv4OrCidrBounds(value: string): { start: number; end: number; canonical: boolean } | null {
  if (!isValidIpv4OrCidr(value)) return null;
  const [ip, prefixText] = value.split('/') as [string, string | undefined];
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  const blockSize = 2 ** (32 - prefix);
  const n = ipv4ToInt(ip);
  const start = Math.floor(n / blockSize) * blockSize;
  return { start, end: start + blockSize - 1, canonical: start === n };
}
