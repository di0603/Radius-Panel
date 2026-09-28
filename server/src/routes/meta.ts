import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { APP_NAME, APP_VERSION } from '../version.js';
import { KNOWN_ATTRIBUTES, RADIUS_DICT } from '../lib/radiusDict.js';
import { radiusPool, panelPool, vpnModuleTablesExist } from '../db/pools.js';

export const metaRouter = Router();

metaRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    let dbOk = true;
    try {
      await Promise.all([radiusPool.query('SELECT 1'), panelPool.query('SELECT 1')]);
    } catch {
      dbOk = false;
    }
    // Sin las tablas de sql/radius-schema-vpn.sql / sql/panel-schema-vpn.sql el
    // modulo VPN se anuncia desactivado en vez de romper /api/meta.
    const vpnEnabled = dbOk && (await vpnModuleTablesExist().catch(() => false));
    res.json({
      name: APP_NAME,
      version: APP_VERSION,
      coaEnabled: config.coa.enabled,
      testAuthEnabled: config.testAuth.enabled,
      googleEnabled: config.google.enabled,
      vpnEnabled,
      dbOk,
    });
  }),
);

metaRouter.get('/dictionary', requireAuth, (_req, res) => {
  res.json({ attributes: KNOWN_ATTRIBUTES, defs: RADIUS_DICT });
});
