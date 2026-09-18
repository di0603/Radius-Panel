/**
 * Menu interactivo de administracion y mantenimiento.
 *
 *   npm run menu        (desde la raiz)   o   npm --prefix server run menu
 *
 * Sin dependencias extra: usa readline. Reutiliza los servicios de la API.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.js';
import {
  assertGoogleAuthSchema,
  assertPanelSchema,
  panelPool,
  radiusPool,
  closePools,
  userMetaTableExists,
} from '../db/pools.js';
import { createUser, deleteUser, listUsers } from '../services/radiusUsers.js';
import { createAdmin, listAdmins, updateAdmin } from '../services/admins.js';

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q: string) => rl.question(q);
const askDefault = async (q: string, def: string) => (await ask(`${q} [${def}]: `)).trim() || def;

const SQL_DIR = join(import.meta.dirname, '..', '..', '..', 'sql');
const SERVER_DIR = join(import.meta.dirname, '..', '..');

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

async function pause(): Promise<void> {
  await ask('\n(enter para continuar) ');
}

/* --------------------------- Esquema / migraciones --------------------------- */

/**
 * `selectDatabase` es necesario para los ficheros de migracion que no hacen su
 * propio `CREATE DATABASE` / `USE` (dan por hecho que la base ya existe), como
 * panel-schema-security.sql. panel-schema.sql y freeradius-schema.sql si crean
 * su base, asi que conectan sin seleccionar ninguna.
 */
async function runSqlFile(
  file: string,
  db: typeof config.panelDb,
  selectDatabase = false,
): Promise<void> {
  const sql = await readFile(join(SQL_DIR, file), 'utf8');
  const conn = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: selectDatabase ? db.database : undefined,
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
    console.log(`\x1b[32m✔\x1b[0m ${file} aplicado`);
  } finally {
    await conn.end();
  }
}

/** Comprueba si faltan las tablas/columnas de la migracion de seguridad. */
async function securityMigrationStatus(): Promise<void> {
  try {
    await assertPanelSchema();
    console.log('\x1b[32m✔\x1b[0m migracion de seguridad aplicada (refresh tokens, 2FA, bloqueo)');
  } catch (err) {
    console.log(`\x1b[33m!\x1b[0m ${(err as Error).message}`);
  }
}

/** Comprueba si faltan las columnas del login con Google (email, google_sub). */
async function googleMigrationStatus(): Promise<void> {
  try {
    await assertGoogleAuthSchema();
    console.log('\x1b[32m✔\x1b[0m migracion de login con Google aplicada');
  } catch (err) {
    console.log(`\x1b[33m!\x1b[0m ${(err as Error).message}`);
  }
}

/** Comprueba si existe panel_user_meta (email/notas de usuarios RADIUS). */
async function userMetaMigrationStatus(): Promise<void> {
  if (await userMetaTableExists()) {
    console.log('\x1b[32m✔\x1b[0m panel_user_meta existe (email/notas de usuarios activo)');
  } else {
    console.log(
      '\x1b[33m!\x1b[0m panel_user_meta no existe: el email/notas de usuarios RADIUS esta vacio.\n' +
        `  Aplica: mysql -u root -p ${config.panelDb.database} < sql/panel-schema-user-meta.sql`,
    );
  }
}

async function schemaStatus(): Promise<void> {
  for (const [label, pool, dbName] of [
    ['panel', panelPool, config.panelDb.database],
    ['radius', radiusPool, config.radiusDb.database],
  ] as const) {
    heading(`Tablas en "${dbName}" (${label})`);
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT table_name AS t,
                table_rows AS filas
         FROM information_schema.tables
         WHERE table_schema = :db
         ORDER BY table_name`,
        { db: dbName },
      );
      if (!rows.length) console.log('  (sin tablas — ejecuta la migracion)');
      else console.table(rows.map((r) => ({ tabla: r.t, filas_aprox: r.filas })));
    } catch (err) {
      console.log(`  error: ${(err as Error).message}`);
    }
  }
}

async function schemaMenu(): Promise<void> {
  for (;;) {
    heading('Esquema / migraciones');
    console.log(
      ` 1) Aplicar sql/panel-schema.sql (tablas del panel)\n` +
        ` 2) Aplicar sql/freeradius-schema.sql (esquema FreeRADIUS)\n` +
        ` 3) Aplicar sql/panel-schema-security.sql (refresh tokens, 2FA, bloqueo de cuenta)\n` +
        ` 4) Aplicar sql/panel-schema-google.sql (login con Google, opcional)\n` +
        ` 5) Aplicar sql/panel-schema-user-meta.sql (email/notas de usuarios RADIUS, opcional)\n` +
        ` 6) Estado de las tablas\n` +
        ` 7) Estado de la migracion de seguridad\n` +
        ` 8) Estado de la migracion de Google\n` +
        ` 9) Estado de email/notas de usuarios\n` +
        ` 0) Volver`,
    );
    const c = (await ask('> ')).trim();
    try {
      if (c === '1') await runSqlFile('panel-schema.sql', config.panelDb);
      else if (c === '2') {
        const ok = await askDefault('Esto crea/actualiza el esquema RADIUS. Continuar? (s/n)', 'n');
        if (ok.toLowerCase() === 's') await runSqlFile('freeradius-schema.sql', config.radiusDb);
      } else if (c === '3') {
        console.log(
          'Idempotente: se puede ejecutar varias veces sin romper nada. Requiere que\n' +
            `"${config.panelDb.database}" ya exista (aplica antes panel-schema.sql si es una instalacion nueva).`,
        );
        await runSqlFile('panel-schema-security.sql', config.panelDb, true);
      } else if (c === '4') {
        console.log(
          'Idempotente. Solo hace falta si vas a activar GOOGLE_CLIENT_ID en server/.env.\n' +
            `Requiere que "${config.panelDb.database}" ya exista.`,
        );
        await runSqlFile('panel-schema-google.sql', config.panelDb, true);
      } else if (c === '5') {
        console.log(
          'Crea panel_user_meta (email/notas por usuario RADIUS). No toca radcheck/radreply.\n' +
            `Requiere que "${config.panelDb.database}" ya exista.`,
        );
        await runSqlFile('panel-schema-user-meta.sql', config.panelDb, true);
      } else if (c === '6') await schemaStatus();
      else if (c === '7') await securityMigrationStatus();
      else if (c === '8') await googleMigrationStatus();
      else if (c === '9') await userMetaMigrationStatus();
      else if (c === '0') return;
    } catch (err) {
      console.log(`\x1b[31merror:\x1b[0m ${(err as Error).message}`);
    }
    if (['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(c)) await pause();
  }
}

/* ------------------------------- Administradores ---------------------------- */

async function adminsMenu(): Promise<void> {
  for (;;) {
    heading('Administradores del panel');
    console.log(
      ` 1) Listar\n 2) Crear\n 3) Cambiar contrasena\n 4) Activar / desactivar\n 0) Volver`,
    );
    const c = (await ask('> ')).trim();
    try {
      if (c === '1') {
        const admins = await listAdmins();
        console.table(
          admins.map((a) => ({
            id: a.id,
            usuario: a.username,
            rol: a.role,
            activo: a.active,
            ultimo_acceso: a.last_login_at ?? '—',
          })),
        );
      } else if (c === '2') {
        const username = await ask('Usuario: ');
        const password = await ask('Contrasena (min 8): ');
        const role = (await askDefault('Rol (admin/operator)', 'operator')) as 'admin' | 'operator';
        if (username.trim() && password.length >= 8) {
          const a = await createAdmin({ username: username.trim(), password, role });
          console.log(`\x1b[32m✔\x1b[0m creado id=${a.id}`);
        } else console.log('Datos invalidos.');
      } else if (c === '3') {
        const id = Number(await ask('id del admin: '));
        const password = await ask('Nueva contrasena (min 8): ');
        if (password.length >= 8) {
          await updateAdmin(id, { password }, -1);
          console.log('\x1b[32m✔\x1b[0m contrasena cambiada');
        } else console.log('Contrasena demasiado corta.');
      } else if (c === '4') {
        const id = Number(await ask('id del admin: '));
        const active = (await askDefault('Activo? (s/n)', 's')).toLowerCase() === 's';
        await updateAdmin(id, { active }, -1);
        console.log('\x1b[32m✔\x1b[0m estado actualizado');
      } else if (c === '0') return;
    } catch (err) {
      console.log(`\x1b[31merror:\x1b[0m ${(err as Error).message}`);
    }
    if (['1', '2', '3', '4'].includes(c)) await pause();
  }
}

/* ------------------------------- Usuarios RADIUS --------------------------- */

async function usersMenu(): Promise<void> {
  for (;;) {
    heading('Usuarios RADIUS');
    console.log(` 1) Listar (ultimos 20)\n 2) Crear\n 3) Borrar\n 0) Volver`);
    const c = (await ask('> ')).trim();
    try {
      if (c === '1') {
        const search = (await ask('Filtro (enter = todos): ')).trim();
        const { items, total } = await listUsers({ search, limit: 20, offset: 0 });
        console.table(
          items.map((u) => ({
            usuario: u.username,
            password: u.passwordType ?? (u.hasPassword ? 'set' : '—'),
            grupos: u.groups.join(', ') || '—',
            reply_attrs: u.replyCount,
          })),
        );
        console.log(`${total} usuarios en total`);
      } else if (c === '2') {
        const username = await ask('Usuario: ');
        const password = await ask('Contrasena: ');
        const passwordType = (await askDefault('Tipo (cleartext/nt)', 'cleartext')) as
          'cleartext' | 'nt';
        const group = (await ask('Grupo (opcional): ')).trim();
        const created = await createUser({
          username: username.trim(),
          password,
          passwordType,
          checks: [],
          replies: [],
          groups: group ? [{ groupname: group, priority: 1 }] : [],
        });
        console.log(`\x1b[32m✔\x1b[0m creado "${created.username}"`);
      } else if (c === '3') {
        const username = (await ask('Usuario a borrar: ')).trim();
        const ok = (
          await askDefault(`Seguro que quieres borrar "${username}"? (s/n)`, 'n')
        ).toLowerCase();
        if (ok === 's') {
          await deleteUser(username);
          console.log('\x1b[32m✔\x1b[0m borrado');
        }
      } else if (c === '0') return;
    } catch (err) {
      console.log(`\x1b[31merror:\x1b[0m ${(err as Error).message}`);
    }
    if (['1', '2', '3'].includes(c)) await pause();
  }
}

/* --------------------------- Registros / diagnostico ---------------------- */

async function logsMenu(): Promise<void> {
  for (;;) {
    heading('Registros y diagnostico');
    console.log(
      ` 1) Ultimas autenticaciones (radpostauth)\n` +
        ` 2) Sesiones activas (radacct)\n` +
        ` 3) Ultimas acciones de auditoria del panel\n` +
        ` 4) Test de conexion a las dos bases de datos\n` +
        ` 0) Volver`,
    );
    const c = (await ask('> ')).trim();
    try {
      if (c === '1') {
        const [rows] = await radiusPool.query<RowDataPacket[]>(
          `SELECT username, reply, authdate FROM radpostauth ORDER BY id DESC LIMIT 20`,
        );
        console.table(rows);
      } else if (c === '2') {
        const [rows] = await radiusPool.query<RowDataPacket[]>(
          `SELECT username, nasipaddress, framedipaddress, callingstationid, acctstarttime
           FROM radacct WHERE acctstoptime IS NULL
           ORDER BY acctstarttime DESC LIMIT 20`,
        );
        console.table(rows);
      } else if (c === '3') {
        const [rows] = await panelPool.query<RowDataPacket[]>(
          `SELECT created_at, admin_name, action, entity, entity_id, ip
           FROM panel_audit_log ORDER BY id DESC LIMIT 20`,
        );
        console.table(rows);
      } else if (c === '4') {
        for (const [label, pool] of [
          ['radius', radiusPool],
          ['panel', panelPool],
        ] as const) {
          try {
            await pool.query('SELECT 1');
            console.log(`\x1b[32m✔\x1b[0m ${label}: OK`);
          } catch (err) {
            console.log(`\x1b[31mx\x1b[0m ${label}: ${(err as Error).message}`);
          }
        }
      } else if (c === '0') return;
    } catch (err) {
      console.log(`\x1b[31merror:\x1b[0m ${(err as Error).message}`);
    }
    if (['1', '2', '3', '4'].includes(c)) await pause();
  }
}

/* ----------------------------------- Tests -------------------------------- */

function runTests(): void {
  heading('Ejecutando tests del backend');
  const res = spawnSync('npm', ['test'], { cwd: SERVER_DIR, stdio: 'inherit', shell: true });
  console.log(res.status === 0 ? '\x1b[32m✔ tests OK\x1b[0m' : '\x1b[31m✗ tests con fallos\x1b[0m');
}

/* ----------------------------------- Main -------------------------------- */

async function main(): Promise<void> {
  try {
    await assertPanelSchema();
  } catch (err) {
    console.log(`\x1b[33m!\x1b[0m ${(err as Error).message}`);
    console.log('(puedes aplicarla desde "1) Esquema / migraciones" -> "3)")\n');
  }
  if (config.google.enabled) {
    try {
      await assertGoogleAuthSchema();
    } catch (err) {
      console.log(`\x1b[33m!\x1b[0m ${(err as Error).message}`);
      console.log('(puedes aplicarla desde "1) Esquema / migraciones" -> "4)")\n');
    }
  }

  for (;;) {
    heading('Radius Panel · menu');
    console.log(
      ` 1) Esquema / migraciones\n` +
        ` 2) Administradores del panel\n` +
        ` 3) Usuarios RADIUS\n` +
        ` 4) Registros y diagnostico\n` +
        ` 5) Ejecutar tests\n` +
        ` 0) Salir`,
    );
    const c = (await ask('> ')).trim();
    if (c === '1') await schemaMenu();
    else if (c === '2') await adminsMenu();
    else if (c === '3') await usersMenu();
    else if (c === '4') await logsMenu();
    else if (c === '5') runTests();
    else if (c === '0') break;
  }
  rl.close();
  await closePools();
  process.exit(0);
}

void main();
