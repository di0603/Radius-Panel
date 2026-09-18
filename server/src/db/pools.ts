import mysql from 'mysql2/promise';
import { config } from '../config.js';

const common = {
  waitForConnections: true,
  connectionLimit: 10,
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

export async function closePools(): Promise<void> {
  await Promise.allSettled([radiusPool.end(), panelPool.end()]);
}
