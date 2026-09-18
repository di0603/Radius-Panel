/**
 * Crea (o actualiza) el primer administrador del panel.
 *
 *   npm run seed:admin
 *
 * Toma usuario/contrasena de SEED_ADMIN_USER / SEED_ADMIN_PASSWORD si estan
 * definidos en server/.env; si no, los pide por consola.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { RowDataPacket } from 'mysql2';
import { panelPool, closePools } from '../db/pools.js';
import { hashPassword } from '../lib/password.js';

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function main(): Promise<void> {
  const username = process.env.SEED_ADMIN_USER || (await ask('Usuario admin: '));
  const password = process.env.SEED_ADMIN_PASSWORD || (await ask('Contrasena (min 8): '));

  if (!username || password.length < 8) {
    console.error('Usuario obligatorio y contrasena de al menos 8 caracteres.');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const [existing] = await panelPool.query<RowDataPacket[]>(
    `SELECT id FROM panel_admins WHERE username = :u`,
    { u: username },
  );

  if (existing.length) {
    await panelPool.query(
      `UPDATE panel_admins SET password_hash = :h, role = 'admin', active = 1 WHERE id = :id`,
      { h: hash, id: existing[0].id },
    );
    console.log(`Administrador "${username}" actualizado (rol admin, activo).`);
  } else {
    await panelPool.query(
      `INSERT INTO panel_admins (username, password_hash, role) VALUES (:u, :h, 'admin')`,
      { u: username, h: hash },
    );
    console.log(`Administrador "${username}" creado con rol admin.`);
  }

  await closePools();
  process.exit(0);
}

void main();
