import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { getVpnSettings } from '../services/vpnSettings.js';
import { generateGatewayToken, hasGatewayToken } from '../services/vpnGatewayToken.js';

/** Ajustes del modulo VPN (solo admin): de momento, solo el token de la puerta de enlace del firewall. */
export const vpnSettingsRouter = Router();
vpnSettingsRouter.use(requireAuth, requireRole('admin'));

vpnSettingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [settings, gatewayTokenSet] = await Promise.all([getVpnSettings(), hasGatewayToken()]);
    res.json({ ...settings, gatewayTokenSet });
  }),
);

vpnSettingsRouter.post(
  '/gateway-token',
  asyncHandler(async (req, res) => {
    const token = await generateGatewayToken();
    // Nunca se audita el token en claro, solo que se (re)genero uno.
    await writeAudit(req, 'create', 'vpn_gateway_token', 'gateway');
    res.status(201).json({ token });
  }),
);
