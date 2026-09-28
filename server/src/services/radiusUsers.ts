import type { RowDataPacket } from 'mysql2';
import { radiusPool } from '../db/pools.js';
import { ntPasswordHash } from '../lib/ntHash.js';
import { conflict, notFound } from '../lib/http.js';
import { deleteUserMeta, getUserMeta, getUserMetaBulk, upsertUserMeta } from './userMeta.js';

export interface AttrRow {
  attribute: string;
  op: string;
  value: string;
}

export interface UserGroup {
  groupname: string;
  priority: number;
}

export interface UserDetail {
  username: string;
  checks: AttrRow[];
  replies: AttrRow[];
  groups: UserGroup[];
  email: string | null;
  notes: string | null;
}

export interface UserSummary {
  username: string;
  hasPassword: boolean;
  passwordType: 'cleartext' | 'nt' | 'other' | null;
  disabled: boolean;
  replyCount: number;
  groups: string[];
  email: string | null;
}

export interface UserWriteInput {
  username: string;
  password?: string | null;
  passwordType?: 'cleartext' | 'nt';
  checks: AttrRow[];
  replies: AttrRow[];
  groups: UserGroup[];
  /** Contacto, opcional. No vive en radcheck/radreply: se guarda en panel_user_meta. */
  email?: string | null;
  notes?: string | null;
}

const PASSWORD_ATTRS = ['Cleartext-Password', 'NT-Password'];

function applyPassword(input: UserWriteInput): AttrRow[] {
  const checks = input.checks.filter((c) => !PASSWORD_ATTRS.includes(c.attribute));
  if (input.password) {
    if (input.passwordType === 'nt') {
      checks.unshift({ attribute: 'NT-Password', op: ':=', value: ntPasswordHash(input.password) });
    } else {
      checks.unshift({ attribute: 'Cleartext-Password', op: ':=', value: input.password });
    }
  }
  return checks;
}

/** Exportada: la reutiliza vpnDevices.ts para comprobar unicidad antes de crear un dispositivo. */
export async function usernameExists(username: string): Promise<boolean> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT 1 FROM radcheck WHERE username = :u
     UNION SELECT 1 FROM radreply WHERE username = :u
     UNION SELECT 1 FROM radusergroup WHERE username = :u
     LIMIT 1`,
    { u: username },
  );
  return rows.length > 0;
}

export async function listUsers(opts: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ items: UserSummary[]; total: number }> {
  const search = opts.search?.trim() ?? '';
  const like = `%${search}%`;

  const unionSql = `
    SELECT username FROM radcheck
    UNION SELECT username FROM radreply
    UNION SELECT username FROM radusergroup`;

  const [countRows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM (${unionSql}) u
     WHERE (:search = '' OR u.username LIKE :like)`,
    { search, like },
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT u.username,
        (SELECT c.attribute FROM radcheck c
           WHERE c.username = u.username AND c.attribute IN ('Cleartext-Password','NT-Password')
           LIMIT 1) AS pw_attr,
        (SELECT COUNT(*) FROM radreply r WHERE r.username = u.username) AS reply_count,
        (SELECT COUNT(*) FROM radcheck c
           WHERE c.username = u.username AND c.attribute = 'Auth-Type' AND c.value = 'Reject') AS disabled,
        (SELECT GROUP_CONCAT(g.groupname ORDER BY g.priority SEPARATOR ',')
           FROM radusergroup g WHERE g.username = u.username) AS groups
     FROM (${unionSql}) u
     WHERE (:search = '' OR u.username LIKE :like)
     ORDER BY u.username
     LIMIT :limit OFFSET :offset`,
    { search, like, limit: opts.limit, offset: opts.offset },
  );

  const metaByUser = await getUserMetaBulk(rows.map((r) => String(r.username)));

  const items: UserSummary[] = rows.map((r) => {
    const pwAttr = r.pw_attr as string | null;
    let passwordType: UserSummary['passwordType'] = null;
    if (pwAttr === 'Cleartext-Password') passwordType = 'cleartext';
    else if (pwAttr === 'NT-Password') passwordType = 'nt';
    return {
      username: r.username as string,
      hasPassword: Boolean(pwAttr),
      passwordType,
      disabled: Number(r.disabled ?? 0) > 0,
      replyCount: Number(r.reply_count ?? 0),
      groups: r.groups ? String(r.groups).split(',') : [],
      email: metaByUser.get(String(r.username))?.email ?? null,
    };
  });

  return { items, total };
}

export async function getUser(username: string): Promise<UserDetail> {
  const [checks] = await radiusPool.query<RowDataPacket[]>(
    `SELECT attribute, op, value FROM radcheck WHERE username = :u ORDER BY id`,
    { u: username },
  );
  const [replies] = await radiusPool.query<RowDataPacket[]>(
    `SELECT attribute, op, value FROM radreply WHERE username = :u ORDER BY id`,
    { u: username },
  );
  const [groups] = await radiusPool.query<RowDataPacket[]>(
    `SELECT groupname, priority FROM radusergroup WHERE username = :u ORDER BY priority`,
    { u: username },
  );
  if (!checks.length && !replies.length && !groups.length) {
    throw notFound(`El usuario "${username}" no existe`);
  }
  const meta = await getUserMeta(username);
  return {
    username,
    checks: checks as AttrRow[],
    replies: replies as AttrRow[],
    groups: groups as UserGroup[],
    email: meta.email,
    notes: meta.notes,
  };
}

async function replaceUserRows(username: string, input: UserWriteInput): Promise<void> {
  const checks = applyPassword(input);
  const conn = await radiusPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM radcheck WHERE username = :u`, { u: username });
    await conn.query(`DELETE FROM radreply WHERE username = :u`, { u: username });
    await conn.query(`DELETE FROM radusergroup WHERE username = :u`, { u: username });

    for (const c of checks) {
      await conn.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES (:u, :a, :o, :v)`,
        { u: username, a: c.attribute, o: c.op || ':=', v: c.value },
      );
    }
    for (const r of input.replies) {
      await conn.query(
        `INSERT INTO radreply (username, attribute, op, value) VALUES (:u, :a, :o, :v)`,
        { u: username, a: r.attribute, o: r.op || '=', v: r.value },
      );
    }
    for (const g of input.groups) {
      await conn.query(
        `INSERT INTO radusergroup (username, groupname, priority) VALUES (:u, :g, :p)`,
        { u: username, g: g.groupname, p: g.priority ?? 1 },
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

export async function createUser(input: UserWriteInput): Promise<UserDetail> {
  if (await usernameExists(input.username)) {
    throw conflict(`El usuario "${input.username}" ya existe`);
  }
  await replaceUserRows(input.username, input);
  await upsertUserMeta(input.username, { email: input.email ?? null, notes: input.notes ?? null });
  return getUser(input.username);
}

export interface BulkUserRow {
  username: string;
  password: string;
  passwordType?: 'cleartext' | 'nt';
  groups?: string[];
}

export async function createUsersBulk(rows: BulkUserRow[]): Promise<{
  created: string[];
  skipped: { username: string; reason: string }[];
}> {
  const created: string[] = [];
  const skipped: { username: string; reason: string }[] = [];
  for (const row of rows) {
    const username = row.username?.trim();
    if (!username) {
      skipped.push({ username: row.username ?? '', reason: 'nombre vacio' });
      continue;
    }
    if (await usernameExists(username)) {
      skipped.push({ username, reason: 'ya existe' });
      continue;
    }
    try {
      await replaceUserRows(username, {
        username,
        password: row.password || null,
        passwordType: row.passwordType ?? 'cleartext',
        checks: [],
        replies: [],
        groups: (row.groups ?? [])
          .filter(Boolean)
          .map((g, i) => ({ groupname: g, priority: i + 1 })),
      });
      created.push(username);
    } catch (err) {
      skipped.push({ username, reason: (err as Error).message });
    }
  }
  return { created, skipped };
}

export async function updateUser(username: string, input: UserWriteInput): Promise<UserDetail> {
  if (!(await usernameExists(username))) {
    throw notFound(`El usuario "${username}" no existe`);
  }
  await replaceUserRows(username, { ...input, username });
  // Igual que con checks/replies/groups: si el llamante manda email o notas, se
  // reemplazan enteros. Si no manda ninguno de los dos, se dejan como estaban
  // (evita que un cliente que aun no conozca estos campos los borre sin querer).
  if (input.email !== undefined || input.notes !== undefined) {
    await upsertUserMeta(username, { email: input.email ?? null, notes: input.notes ?? null });
  }
  return getUser(username);
}

export async function deleteUser(username: string): Promise<void> {
  if (!(await usernameExists(username))) {
    throw notFound(`El usuario "${username}" no existe`);
  }
  const conn = await radiusPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM radcheck WHERE username = :u`, { u: username });
    await conn.query(`DELETE FROM radreply WHERE username = :u`, { u: username });
    await conn.query(`DELETE FROM radusergroup WHERE username = :u`, { u: username });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  // panel_user_meta vive en otra base: se borra aparte, fuera de la transaccion RADIUS.
  await deleteUserMeta(username);
}

export async function setUserGroups(username: string, groups: UserGroup[]): Promise<UserGroup[]> {
  if (!(await usernameExists(username))) {
    throw notFound(`El usuario "${username}" no existe`);
  }
  const conn = await radiusPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM radusergroup WHERE username = :u`, { u: username });
    for (const g of groups) {
      await conn.query(
        `INSERT INTO radusergroup (username, groupname, priority) VALUES (:u, :g, :p)`,
        { u: username, g: g.groupname, p: g.priority ?? 1 },
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT groupname, priority FROM radusergroup WHERE username = :u ORDER BY priority`,
    { u: username },
  );
  return rows as UserGroup[];
}

/**
 * Activa o desactiva un usuario sin borrarlo: un `Auth-Type := Reject` en radcheck
 * hace que FreeRADIUS lo rechace siempre.
 */
export async function setUserEnabled(username: string, enabled: boolean): Promise<void> {
  if (!(await usernameExists(username))) {
    throw notFound(`El usuario "${username}" no existe`);
  }
  if (enabled) {
    await radiusPool.query(
      `DELETE FROM radcheck WHERE username = :u AND attribute = 'Auth-Type' AND value = 'Reject'`,
      { u: username },
    );
  } else {
    const [rows] = await radiusPool.query<RowDataPacket[]>(
      `SELECT id FROM radcheck WHERE username = :u AND attribute = 'Auth-Type' AND value = 'Reject' LIMIT 1`,
      { u: username },
    );
    if (!rows.length) {
      await radiusPool.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES (:u, 'Auth-Type', ':=', 'Reject')`,
        { u: username },
      );
    }
  }
}
