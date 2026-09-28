/**
 * mysql2 formatea los `Date` de JS que se pasan como parametro con el uso
 * horario "local" del proceso (no UTC) salvo que se configure lo contrario
 * en el pool, y las columnas DATETIME de MySQL no guardan huso horario. Como
 * `vpn_certificates` tiene que estar siempre en UTC (FreeRADIUS compara con
 * UTC_TIMESTAMP()), las fechas que no son "ahora mismo" (para eso ya esta
 * `UTC_TIMESTAMP()` en SQL) se formatean aqui a mano con `toISOString()`
 * -que siempre es UTC, sea cual sea el huso horario del sistema- antes de
 * enviarlas.
 */
export function formatUtcDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
