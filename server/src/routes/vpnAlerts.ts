import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getVpnAlerts } from '../services/vpnAlerts.js';

/** Alertas de salud del modulo VPN para la tarjeta "VPN" del panel. Mismos datos que refrescan los Gauges de /metrics. */
export const vpnAlertsRouter = Router();
vpnAlertsRouter.use(requireAuth, requireRole('admin'));

vpnAlertsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await getVpnAlerts());
  }),
);
