import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, unauthorized } from '../lib/http.js';
import { generateFirewallConfig } from '../services/vpnFirewall.js';
import { verifyGatewayToken } from '../services/vpnGatewayToken.js';

/**
 * Descarga del firewall generado para la VM VPN (192.168.10.29):
 * deliberadamente sin `requireAuth` -quien llama es `deploy/vpn-gateway-
 * agent`, una maquina, no un admin con sesion en el panel-, autenticado en
 * su lugar con el token de la puerta de enlace (`Authorization: Bearer`,
 * ver services/vpnGatewayToken.ts). Montado fuera de `/api`, igual que
 * `/pki` (pkiPublic.ts).
 */
export const vpnGatewayRouter = Router();

const gatewayLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, prueba de nuevo en unos minutos' },
});

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

vpnGatewayRouter.get(
  '/firewall.nft',
  gatewayLimiter,
  asyncHandler(async (req, res) => {
    const token = bearerToken(req);
    if (!token || !(await verifyGatewayToken(token))) {
      throw unauthorized('Token de la puerta de enlace invalido');
    }
    const nft = await generateFirewallConfig();
    res.type('text/plain').send(nft);
  }),
);
