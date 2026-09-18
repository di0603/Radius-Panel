import type { RowDataPacket } from 'mysql2';
import { radiusPool } from '../db/pools.js';
import { conflict, notFound } from '../lib/http.js';
import type { AttrRow } from './radiusUsers.js';

export interface GroupDetail {
  groupname: string;
  checks: AttrRow[];
  replies: AttrRow[];
  memberCount: number;
}

export interface GroupSummary {
  groupname: string;
  checkCount: number;
  replyCount: number;
  memberCount: number;
}

export interface GroupWriteInput {
  groupname: string;
  checks: AttrRow[];
  replies: AttrRow[];
}

async function groupExists(name: string): Promise<boolean> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT 1 FROM radgroupcheck WHERE groupname = :g
     UNION SELECT 1 FROM radgroupreply WHERE groupname = :g
     UNION SELECT 1 FROM radusergroup WHERE groupname = :g
     LIMIT 1`,
    { g: name },
  );
  return rows.length > 0;
}

export async function listGroups(): Promise<GroupSummary[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(`
    SELECT g.groupname,
      (SELECT COUNT(*) FROM radgroupcheck c WHERE c.groupname = g.groupname) AS check_count,
      (SELECT COUNT(*) FROM radgroupreply r WHERE r.groupname = g.groupname) AS reply_count,
      (SELECT COUNT(DISTINCT ug.username) FROM radusergroup ug WHERE ug.groupname = g.groupname) AS member_count
    FROM (
      SELECT groupname FROM radgroupcheck
      UNION SELECT groupname FROM radgroupreply
      UNION SELECT groupname FROM radusergroup
    ) g
    ORDER BY g.groupname`);
  return rows.map((r) => ({
    groupname: r.groupname as string,
    checkCount: Number(r.check_count ?? 0),
    replyCount: Number(r.reply_count ?? 0),
    memberCount: Number(r.member_count ?? 0),
  }));
}

export async function getGroup(name: string): Promise<GroupDetail> {
  const [checks] = await radiusPool.query<RowDataPacket[]>(
    `SELECT attribute, op, value FROM radgroupcheck WHERE groupname = :g ORDER BY id`,
    { g: name },
  );
  const [replies] = await radiusPool.query<RowDataPacket[]>(
    `SELECT attribute, op, value FROM radgroupreply WHERE groupname = :g ORDER BY id`,
    { g: name },
  );
  const [members] = await radiusPool.query<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT username) AS n FROM radusergroup WHERE groupname = :g`,
    { g: name },
  );
  if (!checks.length && !replies.length && Number(members[0]?.n ?? 0) === 0) {
    throw notFound(`El grupo "${name}" no existe`);
  }
  return {
    groupname: name,
    checks: checks as AttrRow[],
    replies: replies as AttrRow[],
    memberCount: Number(members[0]?.n ?? 0),
  };
}

async function replaceGroupRows(name: string, input: GroupWriteInput): Promise<void> {
  const conn = await radiusPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM radgroupcheck WHERE groupname = :g`, { g: name });
    await conn.query(`DELETE FROM radgroupreply WHERE groupname = :g`, { g: name });
    for (const c of input.checks) {
      await conn.query(
        `INSERT INTO radgroupcheck (groupname, attribute, op, value) VALUES (:g, :a, :o, :v)`,
        { g: name, a: c.attribute, o: c.op || ':=', v: c.value },
      );
    }
    for (const r of input.replies) {
      await conn.query(
        `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (:g, :a, :o, :v)`,
        { g: name, a: r.attribute, o: r.op || '=', v: r.value },
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function createGroup(input: GroupWriteInput): Promise<GroupDetail> {
  if (await groupExists(input.groupname)) {
    throw conflict(`El grupo "${input.groupname}" ya existe`);
  }
  await replaceGroupRows(input.groupname, input);
  return getGroup(input.groupname);
}

export async function updateGroup(name: string, input: GroupWriteInput): Promise<GroupDetail> {
  if (!(await groupExists(name))) throw notFound(`El grupo "${name}" no existe`);
  await replaceGroupRows(name, input);
  return getGroup(name);
}

export async function deleteGroup(name: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!(await groupExists(name))) throw notFound(`El grupo "${name}" no existe`);
  const [members] = await radiusPool.query<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT username) AS n FROM radusergroup WHERE groupname = :g`,
    { g: name },
  );
  const memberCount = Number(members[0]?.n ?? 0);
  if (memberCount > 0 && !opts.force) {
    throw conflict(
      `El grupo tiene ${memberCount} usuario(s). Usa force=true para quitarlo de todos.`,
    );
  }
  const conn = await radiusPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM radgroupcheck WHERE groupname = :g`, { g: name });
    await conn.query(`DELETE FROM radgroupreply WHERE groupname = :g`, { g: name });
    if (opts.force) {
      await conn.query(`DELETE FROM radusergroup WHERE groupname = :g`, { g: name });
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
