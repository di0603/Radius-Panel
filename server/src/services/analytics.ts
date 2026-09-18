import type { RowDataPacket } from 'mysql2';
import { radiusPool } from '../db/pools.js';

const BYTES_IN_GB = 1024 ** 3;

/* ----------------------- Uso por hora y dia de la semana ---------------------- */

export interface HeatmapCell {
  /** 1 = domingo ... 7 = sabado (DAYOFWEEK de MySQL). */
  weekday: number;
  hour: number;
  accepts: number;
  rejects: number;
}

export async function getHourlyHeatmap(days: number): Promise<HeatmapCell[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT DAYOFWEEK(authdate) AS weekday,
            HOUR(authdate)      AS hour,
            SUM(reply = 'Access-Accept')  AS accepts,
            SUM(reply <> 'Access-Accept') AS rejects
       FROM radpostauth
      WHERE authdate >= (NOW() - INTERVAL :days DAY)
      GROUP BY weekday, hour`,
    { days },
  );
  return rows.map((r) => ({
    weekday: Number(r.weekday),
    hour: Number(r.hour),
    accepts: Number(r.accepts ?? 0),
    rejects: Number(r.rejects ?? 0),
  }));
}

/* --------------------------- Concurrencia por dia ----------------------------- */

export interface ConcurrencyPoint {
  date: string;
  peak: number;
  peakHour: number;
}

/**
 * Pico de sesiones simultaneas por dia.
 *
 * Para cada hora se cuenta cuantas sesiones estaban abiertas en ese tramo y se
 * guarda el maximo del dia. Cruza cada dia con 24 horas contra radacct, asi que
 * el endpoint limita el rango a 90 dias para no castigar a la base de datos.
 */
export async function getPeakConcurrency(days: number): Promise<ConcurrencyPoint[]> {
  const hours = Array.from({ length: 24 }, (_, h) => `SELECT ${h} AS hour`).join(' UNION ALL ');
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT d.date, h.hour, COUNT(*) AS n
       FROM (
         SELECT DISTINCT DATE(acctstarttime) AS date
           FROM radacct
          WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
       ) d
       CROSS JOIN (${hours}) h
       JOIN radacct a
         ON a.acctstarttime < (d.date + INTERVAL (h.hour + 1) HOUR)
        AND (a.acctstoptime IS NULL OR a.acctstoptime >= (d.date + INTERVAL h.hour HOUR))
      GROUP BY d.date, h.hour
      ORDER BY d.date, h.hour`,
    { days },
  );

  const best = new Map<string, ConcurrencyPoint>();
  for (const r of rows) {
    const date = String(r.date);
    const n = Number(r.n ?? 0);
    const current = best.get(date);
    if (!current || n > current.peak) {
      best.set(date, { date, peak: n, peakHour: Number(r.hour) });
    }
  }
  return [...best.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------ Estadisticas por NAS -------------------------- */

export interface NasStats {
  nasipaddress: string;
  sessions: number;
  users: number;
  activeNow: number;
  gb: number;
  avgSessionMinutes: number;
  lastSeen: string | null;
}

export async function getNasStats(days: number): Promise<NasStats[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT nasipaddress,
            COUNT(*)                        AS sessions,
            COUNT(DISTINCT username)        AS users,
            SUM(acctstoptime IS NULL)       AS active_now,
            SUM(acctinputoctets + acctoutputoctets) AS bytes,
            AVG(NULLIF(acctsessiontime, 0)) AS avg_seconds,
            MAX(COALESCE(acctstoptime, acctupdatetime, acctstarttime)) AS last_seen
       FROM radacct
      WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
      GROUP BY nasipaddress
      ORDER BY sessions DESC`,
    { days },
  );
  return rows.map((r) => ({
    nasipaddress: String(r.nasipaddress),
    sessions: Number(r.sessions ?? 0),
    users: Number(r.users ?? 0),
    activeNow: Number(r.active_now ?? 0),
    gb: Number(r.bytes ?? 0) / BYTES_IN_GB,
    avgSessionMinutes: Number(r.avg_seconds ?? 0) / 60,
    lastSeen: r.last_seen ? String(r.last_seen) : null,
  }));
}

/* --------------------------- Duracion de las sesiones ------------------------- */

export interface DurationBucket {
  label: string;
  sessions: number;
}

/**
 * Reparto de sesiones por duracion. Un exceso de sesiones de menos de 5 minutos
 * suele delatar un NAS mal configurado o mala cobertura, no uso real.
 */
export async function getSessionDurations(days: number): Promise<DurationBucket[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT
        SUM(acctsessiontime < 300)                                AS b1,
        SUM(acctsessiontime >= 300   AND acctsessiontime < 1800)  AS b2,
        SUM(acctsessiontime >= 1800  AND acctsessiontime < 7200)  AS b3,
        SUM(acctsessiontime >= 7200  AND acctsessiontime < 28800) AS b4,
        SUM(acctsessiontime >= 28800)                             AS b5
       FROM radacct
      WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
        AND acctsessiontime IS NOT NULL`,
    { days },
  );
  const r = rows[0] ?? {};
  return [
    { label: '< 5 min', sessions: Number(r.b1 ?? 0) },
    { label: '5-30 min', sessions: Number(r.b2 ?? 0) },
    { label: '30 min - 2 h', sessions: Number(r.b3 ?? 0) },
    { label: '2 - 8 h', sessions: Number(r.b4 ?? 0) },
    { label: '> 8 h', sessions: Number(r.b5 ?? 0) },
  ];
}

/* --------------------------- Comparativa de periodos -------------------------- */

export interface PeriodMetric {
  label: string;
  current: number;
  previous: number;
  /** Variacion porcentual; null cuando el periodo anterior estaba a cero. */
  changePct: number | null;
}

function change(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

/** Compara los ultimos N dias con los N dias inmediatamente anteriores. */
export async function getPeriodComparison(days: number): Promise<PeriodMetric[]> {
  const [authRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT
        SUM(authdate >= (NOW() - INTERVAL :days DAY) AND reply = 'Access-Accept')  AS cur_ok,
        SUM(authdate >= (NOW() - INTERVAL :days DAY) AND reply <> 'Access-Accept') AS cur_ko,
        SUM(authdate <  (NOW() - INTERVAL :days DAY) AND reply = 'Access-Accept')  AS prev_ok,
        SUM(authdate <  (NOW() - INTERVAL :days DAY) AND reply <> 'Access-Accept') AS prev_ko
       FROM radpostauth
      WHERE authdate >= (NOW() - INTERVAL :double DAY)`,
    { days, double: days * 2 },
  );

  const [acctRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT
        SUM(CASE WHEN acctstarttime >= (NOW() - INTERVAL :days DAY)
                 THEN acctinputoctets + acctoutputoctets ELSE 0 END) AS cur_bytes,
        SUM(CASE WHEN acctstarttime <  (NOW() - INTERVAL :days DAY)
                 THEN acctinputoctets + acctoutputoctets ELSE 0 END) AS prev_bytes,
        COUNT(DISTINCT CASE WHEN acctstarttime >= (NOW() - INTERVAL :days DAY)
                 THEN username END) AS cur_users,
        COUNT(DISTINCT CASE WHEN acctstarttime <  (NOW() - INTERVAL :days DAY)
                 THEN username END) AS prev_users,
        SUM(acctstarttime >= (NOW() - INTERVAL :days DAY)) AS cur_sessions,
        SUM(acctstarttime <  (NOW() - INTERVAL :days DAY)) AS prev_sessions
       FROM radacct
      WHERE acctstarttime >= (NOW() - INTERVAL :double DAY)`,
    { days, double: days * 2 },
  );

  const a = authRows[0] ?? {};
  const b = acctRows[0] ?? {};
  const metric = (label: string, cur: unknown, prev: unknown): PeriodMetric => {
    const current = Number(cur ?? 0);
    const previous = Number(prev ?? 0);
    return { label, current, previous, changePct: change(current, previous) };
  };

  return [
    metric('Autenticaciones correctas', a.cur_ok, a.prev_ok),
    metric('Rechazos', a.cur_ko, a.prev_ko),
    metric('Usuarios con actividad', b.cur_users, b.prev_users),
    metric('Sesiones', b.cur_sessions, b.prev_sessions),
    metric(
      'Trafico (GB)',
      Number(b.cur_bytes ?? 0) / BYTES_IN_GB,
      Number(b.prev_bytes ?? 0) / BYTES_IN_GB,
    ),
  ];
}

/* --------------------------------- Anomalias ---------------------------------- */

export interface Anomaly {
  kind: 'long-session' | 'heavy-traffic' | 'flapping';
  username: string;
  nasipaddress: string;
  detail: string;
  value: number;
  at: string | null;
}

/**
 * Casos que merecen una mirada: sesiones larguisimas (normalmente un stop que
 * nunca llego), consumos desproporcionados y usuarios que reconectan sin parar,
 * sintoma tipico de mala señal o de un bucle PPPoE.
 */
export async function getAnomalies(days: number, limit = 10): Promise<Anomaly[]> {
  const [longRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT username, nasipaddress, acctsessiontime, acctstarttime
       FROM radacct
      WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
        AND acctsessiontime > 86400
      ORDER BY acctsessiontime DESC
      LIMIT :limit`,
    { days, limit },
  );

  const [heavyRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT username, nasipaddress,
            (acctinputoctets + acctoutputoctets) AS bytes, acctstarttime
       FROM radacct
      WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
      ORDER BY bytes DESC
      LIMIT :limit`,
    { days, limit },
  );

  const [flapRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT username, MAX(nasipaddress) AS nasipaddress,
            COUNT(*) AS sessions, MAX(acctstarttime) AS last_start
       FROM radacct
      WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
        AND acctsessiontime < 300
      GROUP BY username
     HAVING sessions >= 20
      ORDER BY sessions DESC
      LIMIT :limit`,
    { days, limit },
  );

  const hours = (seconds: number) => Math.round(seconds / 3600);
  const gb = (bytes: number) => (bytes / BYTES_IN_GB).toFixed(1);

  return [
    ...longRows.map((r): Anomaly => ({
      kind: 'long-session',
      username: String(r.username),
      nasipaddress: String(r.nasipaddress),
      detail: `Sesion de ${hours(Number(r.acctsessiontime ?? 0))} h sin cierre`,
      value: Number(r.acctsessiontime ?? 0),
      at: r.acctstarttime ? String(r.acctstarttime) : null,
    })),
    ...heavyRows.map((r): Anomaly => ({
      kind: 'heavy-traffic',
      username: String(r.username),
      nasipaddress: String(r.nasipaddress),
      detail: `${gb(Number(r.bytes ?? 0))} GB en una sola sesion`,
      value: Number(r.bytes ?? 0),
      at: r.acctstarttime ? String(r.acctstarttime) : null,
    })),
    ...flapRows.map((r): Anomaly => ({
      kind: 'flapping',
      username: String(r.username),
      nasipaddress: String(r.nasipaddress ?? ''),
      detail: `${Number(r.sessions ?? 0)} sesiones de menos de 5 minutos`,
      value: Number(r.sessions ?? 0),
      at: r.last_start ? String(r.last_start) : null,
    })),
  ];
}

/* ---------------------------- Actividad de un usuario ------------------------- */

export interface UserActivity {
  sessions: {
    acctuniqueid: string;
    nasipaddress: string;
    framedipaddress: string;
    acctstarttime: string | null;
    acctstoptime: string | null;
    acctsessiontime: number | null;
    bytes: number;
    acctterminatecause: string;
  }[];
  auths: { reply: string; authdate: string; accepted: boolean }[];
  totals: { sessions: number; bytes: number; seconds: number; accepts: number; rejects: number };
}

/** Ultimas sesiones e intentos de autenticacion de un usuario, para su ficha. */
export async function getUserActivity(username: string, limit = 10): Promise<UserActivity> {
  const [sessionRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT acctuniqueid, nasipaddress, framedipaddress, acctstarttime, acctstoptime,
            acctsessiontime, (acctinputoctets + acctoutputoctets) AS bytes, acctterminatecause
       FROM radacct
      WHERE username = :u
      ORDER BY acctstarttime DESC
      LIMIT :limit`,
    { u: username, limit },
  );

  const [authRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT reply, authdate FROM radpostauth
      WHERE username = :u
      ORDER BY authdate DESC
      LIMIT :limit`,
    { u: username, limit },
  );

  const [totalRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS sessions,
            COALESCE(SUM(acctinputoctets + acctoutputoctets), 0) AS bytes,
            COALESCE(SUM(acctsessiontime), 0) AS seconds
       FROM radacct WHERE username = :u`,
    { u: username },
  );

  const [authTotals] = await radiusPool.query<RowDataPacket[]>(
    `SELECT SUM(reply = 'Access-Accept') AS accepts,
            SUM(reply <> 'Access-Accept') AS rejects
       FROM radpostauth WHERE username = :u`,
    { u: username },
  );

  return {
    sessions: sessionRows.map((r) => ({
      acctuniqueid: String(r.acctuniqueid),
      nasipaddress: String(r.nasipaddress ?? ''),
      framedipaddress: String(r.framedipaddress ?? ''),
      acctstarttime: r.acctstarttime ? String(r.acctstarttime) : null,
      acctstoptime: r.acctstoptime ? String(r.acctstoptime) : null,
      acctsessiontime: r.acctsessiontime === null ? null : Number(r.acctsessiontime),
      bytes: Number(r.bytes ?? 0),
      acctterminatecause: String(r.acctterminatecause ?? ''),
    })),
    auths: authRows.map((r) => ({
      reply: String(r.reply),
      authdate: String(r.authdate),
      accepted: String(r.reply) === 'Access-Accept',
    })),
    totals: {
      sessions: Number(totalRows[0]?.sessions ?? 0),
      bytes: Number(totalRows[0]?.bytes ?? 0),
      seconds: Number(totalRows[0]?.seconds ?? 0),
      accepts: Number(authTotals[0]?.accepts ?? 0),
      rejects: Number(authTotals[0]?.rejects ?? 0),
    },
  };
}
