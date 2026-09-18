import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { hashPassword } from '../lib/password.js';
import { conflict, notFound, badRequest } from '../lib/http.js';
import type { Role } from '../lib/jwt.js';

export interface Admin {
  id: number;
  username: string;
  role: Role;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}

function mapAdmin(r: RowDataPacket): Admin {
  return {
    id: Number(r.id),
    username: r.username as string,
    role: r.role as Role,
    active: Boolean(r.active),
    created_at: String(r.created_at),
    last_login_at: r.last_login_at ? String(r.last_login_at) : null,
  };
}

export async function listAdmins(): Promise<Admin[]> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT id, username, role, active, created_at, last_login_at FROM panel_admins ORDER BY username`,
  );
  return rows.map(mapAdmin);
}

export async function createAdmin(input: {
  username: string;
  password: string;
  role: Role;
}): Promise<Admin> {
  const [dup] = await panelPool.query<RowDataPacket[]>(
    `SELECT id FROM panel_admins WHERE username = :u`,
    { u: input.username },
  );
  if (dup.length) throw conflict(`Ya existe el administrador "${input.username}"`);
  const hash = await hashPassword(input.password);
  const [res] = await panelPool.query<ResultSetHeader>(
    `INSERT INTO panel_admins (username, password_hash, role) VALUES (:u, :h, :r)`,
    { u: input.username, h: hash, r: input.role },
  );
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT id, username, role, active, created_at, last_login_at FROM panel_admins WHERE id = :id`,
    { id: res.insertId },
  );
  return mapAdmin(rows[0]);
}

export async function updateAdmin(
  id: number,
  input: { password?: string; role?: Role; active?: boolean },
  actingAdminId: number,
): Promise<Admin> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT id, username, role, active FROM panel_admins WHERE id = :id`,
    { id },
  );
  if (!rows.length) throw notFound(`No existe el administrador ${id}`);
  const current = rows[0];

  if (id === actingAdminId && input.active === false) {
    throw badRequest('No puedes desactivar tu propia cuenta');
  }
  if (id === actingAdminId && input.role && input.role !== current.role) {
    throw badRequest('No puedes cambiar tu propio rol');
  }

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (input.password) {
    sets.push('password_hash = :h');
    params.h = await hashPassword(input.password);
  }
  if (input.role) {
    sets.push('role = :r');
    params.r = input.role;
  }
  if (typeof input.active === 'boolean') {
    sets.push('active = :a');
    params.a = input.active ? 1 : 0;
  }
  if (!sets.length) throw badRequest('Nada que actualizar');

  await panelPool.query(
    `UPDATE panel_admins SET ${sets.join(', ')} WHERE id = :id`,
    params as Record<string, string | number>,
  );
  const [updated] = await panelPool.query<RowDataPacket[]>(
    `SELECT id, username, role, active, created_at, last_login_at FROM panel_admins WHERE id = :id`,
    { id },
  );
  return mapAdmin(updated[0]);
}

export async function deleteAdmin(id: number, actingAdminId: number): Promise<void> {
  if (id === actingAdminId) throw badRequest('No puedes borrar tu propia cuenta');
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT id FROM panel_admins WHERE id = :id`,
    { id },
  );
  if (!rows.length) throw notFound(`No existe el administrador ${id}`);

  const [admins] = await panelPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM panel_admins WHERE role = 'admin' AND active = 1`,
  );
  const [target] = await panelPool.query<RowDataPacket[]>(
    `SELECT role, active FROM panel_admins WHERE id = :id`,
    { id },
  );
  if (target[0].role === 'admin' && target[0].active && Number(admins[0].n) <= 1) {
    throw badRequest('No puedes borrar el ultimo administrador activo');
  }
  await panelPool.query(`DELETE FROM panel_admins WHERE id = :id`, { id });
}
