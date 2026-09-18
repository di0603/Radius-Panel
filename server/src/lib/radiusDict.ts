/**
 * Diccionario reducido de atributos RADIUS: sirve para autocompletar en el panel
 * y para validar tipo/valores al guardar. No pretende ser exhaustivo; los
 * atributos que no estan aqui se aceptan sin validar (solo se avisa).
 */

type AttrType = 'string' | 'integer' | 'ipaddr' | 'date' | 'enum';

interface AttrDef {
  type: AttrType;
  values?: string[];
  /** true = tipico en radcheck/radgroupcheck; false = tipico en reply. */
  check?: boolean;
  note?: string;
}

export const RADIUS_DICT: Record<string, AttrDef> = {
  // ---- check ----
  'Cleartext-Password': { type: 'string', check: true },
  'NT-Password': { type: 'string', check: true, note: 'MD4 en hex (lo calcula el panel)' },
  'Password-With-Header': { type: 'string', check: true },
  'Auth-Type': {
    type: 'enum',
    values: ['Accept', 'Reject', 'Local', 'EAP', 'PAP', 'CHAP', 'MS-CHAP'],
    check: true,
  },
  'Simultaneous-Use': { type: 'integer', check: true },
  'Login-Time': { type: 'string', check: true, note: 'p.ej. "Wk0800-1700"' },
  Expiration: { type: 'string', check: true, note: 'p.ej. "01 Jan 2027" o "01 Jan 2027 08:00"' },
  'Calling-Station-Id': { type: 'string' },
  'Called-Station-Id': { type: 'string' },
  'Pool-Name': { type: 'string', check: true },

  // ---- reply: control de sesion ----
  'Session-Timeout': { type: 'integer', note: 'segundos' },
  'Idle-Timeout': { type: 'integer', note: 'segundos' },
  'Acct-Interim-Interval': { type: 'integer', note: 'segundos' },
  'Port-Limit': { type: 'integer' },
  'Service-Type': {
    type: 'enum',
    values: [
      'Login-User',
      'Framed-User',
      'Callback-Login-User',
      'Callback-Framed-User',
      'Outbound-User',
      'Administrative-User',
      'NAS-Prompt-User',
      'Authenticate-Only',
      'Call-Check',
    ],
  },
  'Framed-Protocol': {
    type: 'enum',
    values: ['PPP', 'SLIP', 'ARAP', 'Gandalf-SLML', 'Xylogics-IPX-SLIP', 'X.75-Synchronous'],
  },
  'Framed-IP-Address': { type: 'ipaddr' },
  'Framed-IP-Netmask': { type: 'ipaddr' },
  'Framed-Route': { type: 'string' },
  'Framed-Pool': { type: 'string' },
  'Framed-MTU': { type: 'integer' },
  'Filter-Id': { type: 'string' },
  'Reply-Message': { type: 'string' },
  Class: { type: 'string' },
  'Termination-Action': { type: 'enum', values: ['Default', 'RADIUS-Request'] },
  'Tunnel-Type': { type: 'string' },
  'Tunnel-Medium-Type': { type: 'string' },
  'Tunnel-Private-Group-Id': { type: 'string', note: 'VLAN' },

  // ---- reply: VSA frecuentes de control de ancho de banda ----
  'WISPr-Bandwidth-Max-Up': { type: 'integer', note: 'bps' },
  'WISPr-Bandwidth-Max-Down': { type: 'integer', note: 'bps' },
  'Mikrotik-Rate-Limit': { type: 'string', note: 'p.ej. "10M/50M"' },
  'Mikrotik-Address-List': { type: 'string' },
  'Mikrotik-Group': { type: 'string' },
  'ChilliSpot-Bandwidth-Max-Up': { type: 'integer' },
  'ChilliSpot-Bandwidth-Max-Down': { type: 'integer' },
  'Cisco-AVPair': { type: 'string' },
  'Cisco-Account-Info': { type: 'string' },
};

export const KNOWN_ATTRIBUTES = Object.keys(RADIUS_DICT).sort();

function isIpv4(v: string): boolean {
  const p = v.split('.');
  return p.length === 4 && p.every((n) => /^\d+$/.test(n) && Number(n) >= 0 && Number(n) <= 255);
}

export interface AttrIssue {
  attribute: string;
  value: string;
  level: 'error' | 'warn';
  message: string;
}

/** Valida una fila atributo/valor. Devuelve un problema o null. */
export function validateAttr(attribute: string, value: string): AttrIssue | null {
  const def = RADIUS_DICT[attribute];
  if (!def) {
    return {
      attribute,
      value,
      level: 'warn',
      message: 'Atributo no reconocido (se guardara igual)',
    };
  }
  if (value === '') return null;
  switch (def.type) {
    case 'integer':
      if (!/^-?\d+$/.test(value)) {
        return { attribute, value, level: 'error', message: 'Debe ser un numero entero' };
      }
      break;
    case 'ipaddr':
      if (value !== 'auto' && !isIpv4(value)) {
        return { attribute, value, level: 'error', message: 'Debe ser una IPv4 valida' };
      }
      break;
    case 'enum':
      if (def.values && !def.values.includes(value)) {
        return {
          attribute,
          value,
          level: 'error',
          message: `Valor no valido. Permitidos: ${def.values.join(', ')}`,
        };
      }
      break;
    default:
      break;
  }
  return null;
}

/** Valida una lista; lanza con detalle si hay errores (los warnings no bloquean). */
export function assertAttrs(rows: { attribute: string; value: string }[]): AttrIssue[] {
  const issues = rows
    .map((r) => validateAttr(r.attribute, r.value))
    .filter((i): i is AttrIssue => i !== null);
  return issues;
}
