/**
 * Formatea una huella SHA-256 (hex) para que un humano la compare a ojo
 * contra lo que muestra la app (prompt 12.5, confianza en el primer uso):
 * en grupos de 4 caracteres hexadecimales en MAYUSCULAS ("ABCD EF01 ..."),
 * mas un "codigo corto" (los primeros 8 grupos = 32 caracteres) para
 * comparar de un vistazo sin tener que leer los 64 caracteres completos.
 * Ver README, seccion "Aprovisionamiento de apps".
 */
export interface FormattedFingerprint {
  /** Grupos de 4, mayusculas, separados por espacio: los 64 caracteres completos. */
  full: string;
  /** Los primeros 8 grupos (32 caracteres) del mismo formato. */
  short: string;
}

const GROUP_SIZE = 4;
const SHORT_GROUP_COUNT = 8;

export function formatFingerprint(sha256Hex: string): FormattedFingerprint {
  const upper = sha256Hex.trim().toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < upper.length; i += GROUP_SIZE) {
    groups.push(upper.slice(i, i + GROUP_SIZE));
  }
  return {
    full: groups.join(' '),
    short: groups.slice(0, SHORT_GROUP_COUNT).join(' '),
  };
}
