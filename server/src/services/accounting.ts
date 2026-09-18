import type { RowDataPacket } from 'mysql2';
import { radiusPool } from '../db/pools.js';
import { notFound } from '../lib/http.js';

export interface Session {
  radacctid: number;
  acctsessionid: string;
  acctuniqueid: string;
  username: string;
  nasipaddress: string;
  nasportid: string | null;
  acctstarttime: string | null;
  acctupdatetime: string | null;
  acctstoptime: string | null;
  acctsessiontime: number | null;
  acctinputoctets: number | null;
  acctoutputoctets: number | null;
  callingstationid: string;
  calledstationid: string;
  framedipaddress: string;
  acctterminatecause: string;
}

const SELECT_COLS = `radacctid, acctsessionid, acctuniqueid, username, nasipaddress, nasportid,
  acctstarttime, acctupdatetime, acctstoptime, acctsessiontime,
  acctinputoctets, acctoutputoctets, callingstationid, calledstationid,
  framedipaddress, acctterminatecause`;

export async function listActiveSessions(opts: {
  search?: string;
  nasipaddress?: string;
  limit: number;
  offset: number;
}): Promise<{ items: Session[]; total: number }> {
  const search = opts.search?.trim() ?? '';
  const like = `%${search}%`;
  const nas = opts.nasipaddress?.trim() ?? '';
  const where = `acctstoptime IS NULL
    AND (:search = '' OR username LIKE :like OR framedipaddress LIKE :like OR callingstationid LIKE :like)
    AND (:nas = '' OR nasipaddress = :nas)`;

  const [countRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM radacct WHERE ${where}`,
    { search, like, nas },
  );
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT ${SELECT_COLS} FROM radacct WHERE ${where}
     ORDER BY acctstarttime DESC LIMIT :limit OFFSET :offset`,
    { search, like, nas, limit: opts.limit, offset: opts.offset },
  );
  return { items: rows as Session[], total: Number(countRows[0]?.total ?? 0) };
}

export async function listSessionHistory(opts: {
  username?: string;
  nasipaddress?: string;
  from?: string;
  to?: string;
  limit: number;
  /** Paginacion por keyset: radacctid maximo ya visto (excluido). */
  cursor?: number;
}): Promise<{ items: Session[]; total: number | null; nextCursor: number | null }> {
  const username = opts.username?.trim() ?? '';
  const nas = opts.nasipaddress?.trim() ?? '';
  const from = opts.from?.trim() ?? '';
  const to = opts.to?.trim() ?? '';
  const cursor = opts.cursor ?? 0;
  const where = `(:username = '' OR username = :username)
    AND (:nas = '' OR nasipaddress = :nas)
    AND (:from = '' OR acctstarttime >= :from)
    AND (:to = '' OR acctstarttime <= :to)
    AND (:cursor = 0 OR radacctid < :cursor)`;

  // El COUNT solo en la primera pagina (sin cursor): en tablas enormes es caro.
  let total: number | null = null;
  if (!cursor) {
    const [countRows] = await radiusPool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM radacct WHERE ${where}`,
      { username, nas, from, to, cursor },
    );
    total = Number(countRows[0]?.total ?? 0);
  }

  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT ${SELECT_COLS} FROM radacct WHERE ${where}
     ORDER BY radacctid DESC LIMIT :limit`,
    { username, nas, from, to, cursor, limit: opts.limit },
  );
  const items = rows as Session[];
  const nextCursor = items.length === opts.limit ? Number(items[items.length - 1].radacctid) : null;
  return { items, total, nextCursor };
}

export async function getSessionByUniqueId(acctuniqueid: string): Promise<Session> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT ${SELECT_COLS} FROM radacct WHERE acctuniqueid = :id LIMIT 1`,
    { id: acctuniqueid },
  );
  if (!rows.length) throw notFound(`No existe la sesion ${acctuniqueid}`);
  return rows[0] as Session;
}
