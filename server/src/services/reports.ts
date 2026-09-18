import type { RowDataPacket } from 'mysql2';
import { radiusPool } from '../db/pools.js';

export interface Overview {
  rangeDays: number;
  totals: {
    users: number;
    activeSessions: number;
    accepts: number;
    rejects: number;
  };
  loginsByDay: { date: string; accepts: number; rejects: number }[];
  trafficByDay: { date: string; inputGb: number; outputGb: number }[];
}

const BYTES_IN_GB = 1024 ** 3;

export async function getOverview(days: number): Promise<Overview> {
  const [userRows] = await radiusPool.query<RowDataPacket[]>(`
    SELECT COUNT(*) AS n FROM (
      SELECT username FROM radcheck
      UNION SELECT username FROM radusergroup
    ) u`);

  const [activeRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM radacct WHERE acctstoptime IS NULL`,
  );

  const [totalsRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT
        SUM(reply = 'Access-Accept') AS accepts,
        SUM(reply <> 'Access-Accept') AS rejects
     FROM radpostauth
     WHERE authdate >= (NOW() - INTERVAL :days DAY)`,
    { days },
  );

  const [loginRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT DATE(authdate) AS date,
        SUM(reply = 'Access-Accept') AS accepts,
        SUM(reply <> 'Access-Accept') AS rejects
     FROM radpostauth
     WHERE authdate >= (NOW() - INTERVAL :days DAY)
     GROUP BY DATE(authdate)
     ORDER BY date`,
    { days },
  );

  const [trafficRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT DATE(acctstarttime) AS date,
        SUM(acctinputoctets) AS input_bytes,
        SUM(acctoutputoctets) AS output_bytes
     FROM radacct
     WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
     GROUP BY DATE(acctstarttime)
     ORDER BY date`,
    { days },
  );

  return {
    rangeDays: days,
    totals: {
      users: Number(userRows[0]?.n ?? 0),
      activeSessions: Number(activeRows[0]?.n ?? 0),
      accepts: Number(totalsRows[0]?.accepts ?? 0),
      rejects: Number(totalsRows[0]?.rejects ?? 0),
    },
    loginsByDay: loginRows.map((r) => ({
      date: String(r.date),
      accepts: Number(r.accepts ?? 0),
      rejects: Number(r.rejects ?? 0),
    })),
    trafficByDay: trafficRows.map((r) => ({
      date: String(r.date),
      inputGb: Number(r.input_bytes ?? 0) / BYTES_IN_GB,
      outputGb: Number(r.output_bytes ?? 0) / BYTES_IN_GB,
    })),
  };
}

export async function getTopUsers(opts: {
  days: number;
  metric: 'traffic' | 'time';
  limit: number;
}): Promise<
  {
    username: string;
    inputOctets: number;
    outputOctets: number;
    sessionTime: number;
    sessions: number;
  }[]
> {
  const orderExpr =
    opts.metric === 'time' ? 'SUM(acctsessiontime)' : 'SUM(acctinputoctets + acctoutputoctets)';
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT username,
        SUM(acctinputoctets) AS input_octets,
        SUM(acctoutputoctets) AS output_octets,
        SUM(acctsessiontime) AS session_time,
        COUNT(*) AS sessions
     FROM radacct
     WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
     GROUP BY username
     ORDER BY ${orderExpr} DESC
     LIMIT :limit`,
    { days: opts.days, limit: opts.limit },
  );
  return rows.map((r) => ({
    username: r.username as string,
    inputOctets: Number(r.input_octets ?? 0),
    outputOctets: Number(r.output_octets ?? 0),
    sessionTime: Number(r.session_time ?? 0),
    sessions: Number(r.sessions ?? 0),
  }));
}

export async function getTerminateCauses(
  days: number,
): Promise<{ cause: string; count: number }[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT COALESCE(NULLIF(acctterminatecause, ''), '(sin dato)') AS cause, COUNT(*) AS n
     FROM radacct
     WHERE acctstoptime IS NOT NULL AND acctstoptime >= (NOW() - INTERVAL :days DAY)
     GROUP BY cause ORDER BY n DESC LIMIT 15`,
    { days },
  );
  return rows.map((r) => ({ cause: String(r.cause), count: Number(r.n ?? 0) }));
}

export async function getTopNas(
  days: number,
): Promise<{ nasipaddress: string; sessions: number; users: number; gb: number }[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT nasipaddress,
        COUNT(*) AS sessions,
        COUNT(DISTINCT username) AS users,
        SUM(acctinputoctets + acctoutputoctets) AS bytes
     FROM radacct
     WHERE acctstarttime >= (NOW() - INTERVAL :days DAY)
     GROUP BY nasipaddress ORDER BY sessions DESC LIMIT 15`,
    { days },
  );
  return rows.map((r) => ({
    nasipaddress: String(r.nasipaddress),
    sessions: Number(r.sessions ?? 0),
    users: Number(r.users ?? 0),
    gb: Number(r.bytes ?? 0) / BYTES_IN_GB,
  }));
}

export async function getInactiveUsers(opts: {
  days: number;
  limit: number;
}): Promise<{ username: string; lastAuth: string | null }[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT u.username, MAX(p.authdate) AS last_auth
     FROM (SELECT DISTINCT username FROM radcheck) u
     LEFT JOIN radpostauth p ON p.username = u.username
     GROUP BY u.username
     HAVING last_auth IS NULL OR last_auth < (NOW() - INTERVAL :days DAY)
     ORDER BY last_auth IS NULL DESC, last_auth ASC
     LIMIT :limit`,
    { days: opts.days, limit: opts.limit },
  );
  return rows.map((r) => ({
    username: String(r.username),
    lastAuth: r.last_auth ? String(r.last_auth) : null,
  }));
}

export async function getAuthFailures(opts: {
  days: number;
  limit: number;
}): Promise<{ username: string; failures: number; lastAt: string }[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT username, COUNT(*) AS failures, MAX(authdate) AS last_at
     FROM radpostauth
     WHERE reply <> 'Access-Accept'
       AND authdate >= (NOW() - INTERVAL :days DAY)
     GROUP BY username
     ORDER BY failures DESC
     LIMIT :limit`,
    { days: opts.days, limit: opts.limit },
  );
  return rows.map((r) => ({
    username: r.username as string,
    failures: Number(r.failures ?? 0),
    lastAt: String(r.last_at),
  }));
}
