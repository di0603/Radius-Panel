import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { APP_NAME, APP_VERSION } from '../version.js';
import { KNOWN_ATTRIBUTES, RADIUS_DICT } from '../lib/radiusDict.js';
import { radiusPool, panelPool } from '../db/pools.js';

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
    res.json({
      name: APP_NAME,
      version: APP_VERSION,
      coaEnabled: config.coa.enabled,
      testAuthEnabled: config.testAuth.enabled,
      dbOk,
    });
  }),
);

metaRouter.get('/dictionary', requireAuth, (_req, res) => {
  res.json({ attributes: KNOWN_ATTRIBUTES, defs: RADIUS_DICT });
});
