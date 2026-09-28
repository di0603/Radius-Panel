import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.js';

const common = {
  waitForConnections: true,
  connectionLimit: config.dbPoolSize,
  namedPlaceholders: true,
  dateStrings: true as const,
};

/** Pool contra la base de datos de FreeRADIUS (radcheck, radacct, nas, ...). */
export const radiusPool = mysql.createPool({ ...config.radiusDb, ...common });

/** Pool contra la base de datos propia del panel (panel_admins, panel_audit_log). */
export const panelPool = mysql.createPool({ ...config.panelDb, ...common });

export async function assertDbConnectivity(): Promise<void> {
  await radiusPool.query('SELECT 1');
  await panelPool.query('SELECT 1');
}

/** Tablas y columnas que el panel necesita y que no estaban en la version inicial. */
const REQUIRED_TABLES = ['panel_refresh_tokens', 'panel_login_attempts'];
const REQUIRED_ADMIN_COLUMNS = [
  'failed_attempts',
  'locked_until',
  'totp_secret',
  'totp_enabled',
  'password_changed_at',
];

/**
 * Comprueba que el esquema del panel esta al dia. Es preferible morir al
 * arrancar con un mensaje claro que descubrirlo en el primer login.
 */
export async function assertPanelSchema(): Promise<void> {
  const [tables] = await panelPool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    [REQUIRED_TABLES],
  );
  const missingTables = REQUIRED_TABLES.filter(
    (t) => !tables.some((row) => String(row.TABLE_NAME) === t),
  );

  const [columns] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_admins'`,
  );
  const missingColumns = REQUIRED_ADMIN_COLUMNS.filter(
    (c) => !columns.some((row) => String(row.COLUMN_NAME) === c),
  );

  if (missingTables.length || missingColumns.length) {
    const detail = [
      missingTables.length ? `tablas: ${missingTables.join(', ')}` : '',
      missingColumns.length ? `columnas en panel_admins: ${missingColumns.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    throw new Error(
      `El esquema de la base de datos del panel esta desactualizado (falta ${detail}).\n` +
        `Aplica la migracion antes de arrancar:\n` +
        `  mysql -u root -p ${config.panelDb.database} < sql/panel-schema-security.sql`,
    );
  }
}

const REQUIRED_GOOGLE_COLUMNS = ['email', 'google_sub'];

/** Solo se llama cuando GOOGLE_CLIENT_ID esta configurado: sin eso, la funcion no hace falta. */
export async function assertGoogleAuthSchema(): Promise<void> {
  const [columns] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_admins'`,
  );
  const missing = REQUIRED_GOOGLE_COLUMNS.filter(
    (c) => !columns.some((row) => String(row.COLUMN_NAME) === c),
  );
  if (missing.length) {
    throw new Error(
      `GOOGLE_CLIENT_ID esta configurado pero falta el esquema para el login con Google ` +
        `(columnas: ${missing.join(', ')}).\n` +
        `Aplica la migracion antes de arrancar:\n` +
        `  mysql -u root -p ${config.panelDb.database} < sql/panel-schema-google.sql`,
    );
  }
}

/**
 * A diferencia de assertPanelSchema/assertGoogleAuthSchema, esta no lanza: la
 * tabla es opcional (userMeta.ts se degrada solo sin ella), asi que solo sirve
 * para informar en el menu de administracion si esta o no.
 */
export async function userMetaTableExists(): Promise<boolean> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_user_meta'`,
  );
  return rows.length > 0;
}

/**
 * Comprueba si sql/panel-schema-vpn-pki.sql ya esta aplicada (columnas del
 * ciclo de vida de la CA intermedia: status, private_key_encrypted, ...). No
 * lanza: solo informa en el menu de administracion, igual que
 * `userMetaTableExists`.
 */
export async function pkiCaExtendedSchemaExists(): Promise<boolean> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_pki_ca' AND COLUMN_NAME = 'status'`,
  );
  return rows.length > 0;
}

const VPN_RADIUS_TABLES = ['vpn_certificates'];
const VPN_PANEL_TABLES = [
  'panel_vpn_devices',
  'panel_vpn_enroll_tokens',
  'panel_pki_ca',
  'panel_vpn_settings',
];

async function tablesExist(pool: typeof radiusPool, tables: string[]): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    [tables],
  );
  return tables.every((t) => rows.some((row) => String(row.TABLE_NAME) === t));
}

/**
 * El modulo VPN (PKI + enrolamiento de dispositivos) es opcional, igual que
 * panel_user_meta: sin las tablas de sql/radius-schema-vpn.sql y
 * sql/panel-schema-vpn.sql, el panel arranca igual y el modulo se anuncia
 * desactivado en /api/meta en vez de romper el arranque.
 */
export async function vpnModuleTablesExist(): Promise<boolean> {
  const [radiusOk, panelOk] = await Promise.all([
    tablesExist(radiusPool, VPN_RADIUS_TABLES),
    tablesExist(panelPool, VPN_PANEL_TABLES),
  ]);
  return radiusOk && panelOk;
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([radiusPool.end(), panelPool.end()]);
}
