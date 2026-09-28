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
