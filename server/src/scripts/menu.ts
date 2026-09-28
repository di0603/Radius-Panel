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
  vpnModuleTablesExist,
  pkiCaExtendedSchemaExists,
  vpnDevicesExtendedSchemaExists,
  vpnCertificateIssuerColumnExists,
  vpnSettingsExtendedSchemaExists,
  vpnAndroidSchemaExists,
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

/** Comprueba si esta completo el esquema del modulo VPN (PKI + enrolamiento). */
async function vpnMigrationStatus(): Promise<void> {
  if (await vpnModuleTablesExist()) {
    console.log('\x1b[32m✔\x1b[0m modulo VPN activo (tablas presentes en radius y radius_panel)');
  } else {
    console.log(
      '\x1b[33m!\x1b[0m modulo VPN incompleto: el panel lo anuncia desactivado en /api/meta.\n' +
        `  Aplica: mysql -u root -p ${config.radiusDb.database} < sql/radius-schema-vpn.sql\n` +
        `  Aplica: mysql -u root -p ${config.panelDb.database} < sql/panel-schema-vpn.sql`,
    );
  }
}

/** Comprueba si panel_pki_ca tiene el esquema de CLAUDE.md (correccion 4.5). */
async function pkiCaMigrationStatus(): Promise<void> {
  if (await pkiCaExtendedSchemaExists()) {
    console.log(
      '\x1b[32m✔\x1b[0m panel_pki_ca en el esquema correcto (root_cert_pem, ECDSA P-384)',
    );
  } else {
    console.log(
      '\x1b[33m!\x1b[0m panel_pki_ca tiene el esquema anterior (role/subject_cn): la pagina PKI\n' +
        '  fallara al usarla.\n' +
        `  Aplica: mysql -u root -p ${config.panelDb.database} < sql/panel-schema-vpn-pki.sql`,
    );
  }
}

/** Comprueba si panel_vpn_devices y vpn_certificates.ca_id tienen el esquema de CLAUDE.md. */
async function vpnDevicesMigrationStatus(): Promise<void> {
  if (await vpnDevicesExtendedSchemaExists()) {
    console.log(
      '\x1b[32m✔\x1b[0m panel_vpn_devices en el esquema correcto (owner_user, device_label...)',
    );
  } else {
    console.log(
      '\x1b[33m!\x1b[0m panel_vpn_devices tiene el esquema anterior: la seccion Dispositivos fallara.\n' +
        `  Aplica: mysql -u root -p ${config.panelDb.database} < sql/panel-schema-vpn-devices.sql`,
    );
  }
  if (await vpnCertificateIssuerColumnExists()) {
    console.log('\x1b[32m✔\x1b[0m vpn_certificates.ca_id existe (enlace con la CA emisora)');
  } else {
    console.log(
      '\x1b[33m!\x1b[0m falta vpn_certificates.ca_id: revocar un certificado no podra regenerar\n' +
        '  la CRL de su CA automaticamente.\n' +
        `  Aplica: mysql -u root -p ${config.radiusDb.database} < sql/radius-schema-vpn-issuer.sql`,
    );
  }
}

/** Comprueba si panel_vpn_settings/panel_vpn_enroll_tokens tienen el esquema de CLAUDE.md. */
async function vpnSettingsMigrationStatus(): Promise<void> {
  if (await vpnSettingsExtendedSchemaExists()) {
    console.log('\x1b[32m✔\x1b[0m panel_vpn_settings tiene aaa_id/est_url');
  } else {
    console.log(
      '\x1b[33m!\x1b[0m falta panel_vpn_settings.aaa_id/est_url.\n' +
        `  Aplica: mysql -u root -p ${config.panelDb.database} < sql/panel-schema-vpn-4.5.sql`,
    );
  }
}

/** Comprueba si esta aplicada la migracion de descarga de .p12 para Android. */
async function vpnAndroidMigrationStatus(): Promise<void> {
  if (await vpnAndroidSchemaExists()) {
    console.log('\x1b[32m✔\x1b[0m panel_vpn_settings.lan_cidr y panel_vpn_android_downloads existen');
  } else {
    console.log(
      '\x1b[33m!\x1b[0m falta lan_cidr/panel_vpn_android_downloads: "Emitir certificado" en\n' +
        '  dispositivos Android fallara.\n' +
        `  Aplica: mysql -u root -p ${config.panelDb.database} < sql/panel-schema-vpn-android.sql`,
    );
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
        ` 6) Aplicar sql/radius-schema-vpn.sql (tabla de certificados VPN, opcional)\n` +
        ` 7) Aplicar sql/panel-schema-vpn.sql (dispositivos/PKI/ajustes VPN, opcional)\n` +
        ` 8) Aplicar sql/panel-schema-vpn-pki.sql (esquema correcto de panel_pki_ca, opcional)\n` +
        ` 9) Aplicar sql/panel-schema-vpn-devices.sql (esquema correcto de panel_vpn_devices, opcional)\n` +
        ` 10) Aplicar sql/radius-schema-vpn-issuer.sql (vpn_certificates.ca_id, opcional)\n` +
        ` 11) Aplicar sql/panel-schema-vpn-4.5.sql (aaa_id/est_url, token_sha256, opcional)\n` +
        ` 12) Aplicar sql/panel-schema-vpn-android.sql (descarga de .p12 para Android, opcional)\n` +
        ` 13) Estado de las tablas\n` +
        ` 14) Estado de la migracion de seguridad\n` +
        ` 15) Estado de la migracion de Google\n` +
        ` 16) Estado de email/notas de usuarios\n` +
        ` 17) Estado del modulo VPN\n` +
        ` 18) Estado de la CA intermedia (PKI)\n` +
        ` 19) Estado de dispositivos VPN\n` +
        ` 20) Estado de ajustes VPN\n` +
        ` 21) Estado de la descarga de .p12 para Android\n` +
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
      } else if (c === '6') {
        console.log(
          'Idempotente. Crea/completa vpn_certificates en la base de FreeRADIUS. No toca\n' +
            'radcheck/radreply/radusergroup ni la fila de prueba "vps" si ya existe.',
        );
        await runSqlFile('radius-schema-vpn.sql', config.radiusDb, true);
      } else if (c === '7') {
        console.log(
          'Idempotente. Crea dispositivos/tokens de alta/PKI/ajustes del modulo VPN.\n' +
            `Requiere que "${config.panelDb.database}" ya exista.`,
        );
        await runSqlFile('panel-schema-vpn.sql', config.panelDb, true);
      } else if (c === '8') {
        console.log(
          'Idempotente, pero recrea panel_pki_ca vacia con el esquema correcto (correccion 4.5):\n' +
            'no hay ninguna CA intermedia real desplegada todavia. No toca radius.vpn_certificates.',
        );
        const ok = await askDefault('Continuar? (s/n)', 's');
        if (ok.toLowerCase() === 's')
          await runSqlFile('panel-schema-vpn-pki.sql', config.panelDb, true);
      } else if (c === '9') {
        console.log(
          'Idempotente, pero recrea panel_vpn_devices vacia con el esquema correcto (correccion\n' +
            '4.5): no hay ningun dispositivo real dado de alta por el panel todavia. No toca\n' +
            'radcheck/radreply/radusergroup ni radius.vpn_certificates.',
        );
        const ok = await askDefault('Continuar? (s/n)', 's');
        if (ok.toLowerCase() === 's')
          await runSqlFile('panel-schema-vpn-devices.sql', config.panelDb, true);
      } else if (c === '10') {
        console.log(
          'Idempotente. Sustituye vpn_certificates.ca_serial por ca_id (INT). No toca la fila de\n' +
            'prueba "vps" (queda con ca_id NULL).',
        );
        await runSqlFile('radius-schema-vpn-issuer.sql', config.radiusDb, true);
      } else if (c === '11') {
        console.log(
          'Idempotente. Anade aaa_id/est_url a panel_vpn_settings (conserva la fila existente) y\n' +
            'recrea panel_vpn_enroll_tokens vacia con la columna token_sha256.',
        );
        await runSqlFile('panel-schema-vpn-4.5.sql', config.panelDb, true);
      } else if (c === '12') {
        console.log(
          'Idempotente. Anade panel_vpn_settings.lan_cidr y crea panel_vpn_android_downloads\n' +
            '(descarga de un solo uso del .p12 de dispositivos Android).',
        );
        await runSqlFile('panel-schema-vpn-android.sql', config.panelDb, true);
      } else if (c === '13') await schemaStatus();
      else if (c === '14') await securityMigrationStatus();
      else if (c === '15') await googleMigrationStatus();
      else if (c === '16') await userMetaMigrationStatus();
      else if (c === '17') await vpnMigrationStatus();
      else if (c === '18') await pkiCaMigrationStatus();
      else if (c === '19') await vpnDevicesMigrationStatus();
      else if (c === '20') await vpnSettingsMigrationStatus();
      else if (c === '21') await vpnAndroidMigrationStatus();
      else if (c === '0') return;
    } catch (err) {
      console.log(`\x1b[31merror:\x1b[0m ${(err as Error).message}`);
    }
    if (
      [
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
        '12',
        '13',
        '14',
        '15',
        '16',
        '17',
        '18',
        '19',
        '20',
        '21',
      ].includes(c)
    ) {
      await pause();
    }
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
