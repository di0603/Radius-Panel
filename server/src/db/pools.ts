import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * mysql2 formatea los `Date` de JS que se pasan como parametro con el uso
 * horario "local" del proceso, no UTC, salvo que se le diga lo contrario
 * (comprobado: sin esto, `new Date('2024-01-01T00:00:00Z')` se escribe como
 * '2024-01-01 01:00:00' en un proceso con TZ=Europe/Madrid). El modulo VPN
 * necesita que vpn_certificates, panel_vpn_enroll_tokens y
 * panel_vpn_android_downloads esten siempre en UTC (FreeRADIUS y los propios
 * clientes EST comparan con UTC_TIMESTAMP()), asi que `timezone: 'Z'` fuerza
 * ese formateo del lado del cliente para los dos pools -- no solo para el
 * modulo VPN, ya que ambos son compartidos por toda la aplicacion.
 */
const common = {
  waitForConnections: true,
  connectionLimit: config.dbPoolSize,
  namedPlaceholders: true,
  dateStrings: true as const,
  timezone: 'Z' as const,
};

/** Pool contra la base de datos de FreeRADIUS (radcheck, radacct, nas, ...). */
export const radiusPool = mysql.createPool({ ...config.radiusDb, ...common });

/** Pool contra la base de datos propia del panel (panel_admins, panel_audit_log). */
export const panelPool = mysql.createPool({ ...config.panelDb, ...common });

/**
 * Ademas de `timezone: 'Z'` (que solo controla como formatea mysql2 los
 * `Date` de JS), fija tambien el `time_zone` de la SESION de MySQL a UTC en
 * cuanto se abre cada conexion fisica del pool: asi NOW()/UTC_TIMESTAMP() y
 * las comparaciones de fecha en SQL ven UTC igual, sea cual sea el huso
 * horario configurado en el propio servidor MySQL.
 *
 * mysql2 emite 'connection' con la conexion "cruda" (estilo callback) del
 * pool interno, no con el wrapper de promesas -- de ahi el cast y el uso de
 * un callback en vez de `await`.
 */
function forceUtcSession(pool: mysql.Pool): void {
  pool.on('connection', (connection) => {
    (connection as unknown as { query: (sql: string, cb: (err: Error | null) => void) => void }).query(
      "SET time_zone = '+00:00'",
      (err) => {
        if (err) logger.error({ err }, '[db] no se ha podido fijar time_zone en una conexion nueva');
      },
    );
  });
}
forceUtcSession(radiusPool);
forceUtcSession(panelPool);

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
 * Comprueba si panel_pki_ca ya tiene el esquema de CLAUDE.md (una fila por
 * intermedia, con `root_cert_pem`) en vez del esquema anterior (`role`,
 * CA raiz como fila propia). No lanza: solo informa en el menu de
 * administracion, igual que `userMetaTableExists`.
 */
export async function pkiCaExtendedSchemaExists(): Promise<boolean> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_pki_ca' AND COLUMN_NAME = 'root_cert_pem'`,
  );
  return rows.length > 0;
}

/** Comprueba si panel_vpn_devices ya tiene el esquema de CLAUDE.md (owner_user, device_label, enabled...). */
export async function vpnDevicesExtendedSchemaExists(): Promise<boolean> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_vpn_devices' AND COLUMN_NAME = 'owner_user'`,
  );
  return rows.length > 0;
}

/** Comprueba si vpn_certificates ya tiene `ca_id` (modelo de CLAUDE.md) en vez de `ca_serial`. */
export async function vpnCertificateIssuerColumnExists(): Promise<boolean> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vpn_certificates' AND COLUMN_NAME = 'ca_id'`,
  );
  return rows.length > 0;
}

/** Comprueba si panel_vpn_settings tiene aaa_id/est_url (correccion 4.5). */
export async function vpnSettingsExtendedSchemaExists(): Promise<boolean> {
  const [rows] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_vpn_settings' AND COLUMN_NAME = 'aaa_id'`,
  );
  return rows.length > 0;
}

/** Comprueba si esta aplicada sql/panel-schema-vpn-android.sql (lan_cidr + tabla de descargas). */
export async function vpnAndroidSchemaExists(): Promise<boolean> {
  const [columns] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_vpn_settings' AND COLUMN_NAME = 'lan_cidr'`,
  );
  if (!columns.length) return false;
  const [tables] = await panelPool.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_vpn_android_downloads'`,
  );
  return tables.length > 0;
}

/** Comprueba si esta aplicada sql/panel-schema-vpn-firewall.sql (permisos por dispositivo + token de gateway). */
export async function vpnFirewallSchemaExists(): Promise<boolean> {
  const [columns] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_vpn_devices' AND COLUMN_NAME = 'allow_radius_host'`,
  );
  if (!columns.length) return false;
  const [tables] = await panelPool.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_vpn_device_rules'`,
  );
  return tables.length > 0;
}

/** Comprueba si esta aplicada sql/panel-schema-vpn-provisioning.sql (version minima de app). */
export async function vpnProvisioningSchemaExists(): Promise<boolean> {
  const [columns] = await panelPool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_vpn_settings' AND COLUMN_NAME = 'min_app_version'`,
  );
  return columns.length > 0;
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
