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

export async function closePools(): Promise<void> {
  await Promise.allSettled([radiusPool.end(), panelPool.end()]);
}
