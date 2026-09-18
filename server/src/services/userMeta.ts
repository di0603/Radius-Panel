import type { RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { logger } from '../lib/logger.js';

export interface UserMeta {
  email: string | null;
  notes: string | null;
}

const EMPTY_META: UserMeta = { email: null, notes: null };

/**
 * `panel_user_meta` vive en la base del panel, no en la de FreeRADIUS: nunca
 * se puede hacer JOIN con radcheck/radusergroup en SQL (pueden estar en
 * servidores distintos), asi que siempre se consulta aparte y se combina en
 * JavaScript.
 *
 * La tabla es opcional (no la exige assertPanelSchema): si no esta creada,
 * estas funciones se degradan a "sin metadatos" en vez de romper el CRUD de
 * usuarios RADIUS, que es lo esencial. Solo se avisa una vez en el log.
 */
let warnedMissingTable = false;
function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}
function warnOnceMissingTable(): void {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  logger.warn(
    'panel_user_meta no existe: el email/notas de usuarios RADIUS estara vacio. ' +
      'Aplica sql/panel-schema-user-meta.sql para activarlo.',
  );
}

export async function getUserMeta(username: string): Promise<UserMeta> {
  try {
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT email, notes FROM panel_user_meta WHERE username = :u`,
      { u: username },
    );
    if (!rows[0]) return EMPTY_META;
    return { email: rows[0].email ?? null, notes: rows[0].notes ?? null };
  } catch (err) {
    if (isMissingTable(err)) {
      warnOnceMissingTable();
      return EMPTY_META;
    }
    throw err;
  }
}

/** Version en bloque de `getUserMeta`, para no hacer una consulta por fila de un listado. */
export async function getUserMetaBulk(usernames: string[]): Promise<Map<string, UserMeta>> {
  const map = new Map<string, UserMeta>();
  if (!usernames.length) return map;
  try {
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT username, email, notes FROM panel_user_meta WHERE username IN (?)`,
      [usernames],
    );
    for (const r of rows) {
      map.set(String(r.username), { email: r.email ?? null, notes: r.notes ?? null });
    }
  } catch (err) {
    if (isMissingTable(err)) warnOnceMissingTable();
    else throw err;
  }
  return map;
}

/** Crea o actualiza el email/notas de un usuario. Silencioso si la tabla no existe aun. */
export async function upsertUserMeta(username: string, meta: UserMeta): Promise<void> {
  if (!meta.email && !meta.notes) {
    await deleteUserMeta(username);
    return;
  }
  try {
    await panelPool.query(
      `INSERT INTO panel_user_meta (username, email, notes) VALUES (:u, :email, :notes)
       ON DUPLICATE KEY UPDATE email = VALUES(email), notes = VALUES(notes)`,
      { u: username, email: meta.email, notes: meta.notes },
    );
  } catch (err) {
    if (isMissingTable(err)) warnOnceMissingTable();
    else throw err;
  }
}

export async function deleteUserMeta(username: string): Promise<void> {
  try {
    await panelPool.query(`DELETE FROM panel_user_meta WHERE username = :u`, { u: username });
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}
