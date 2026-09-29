import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { formatFingerprint, type FormattedFingerprint } from '../lib/fingerprint.js';
import { sha256Hex } from '../lib/x509.js';
import { getSignerPublicKeySha256Hex, isProfileSigningConfigured } from '../lib/vpnProfileSigning.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { getRootCaCert } from '../services/pki.js';
import { getVpnSettings } from '../services/vpnSettings.js';
import { generateGatewayToken, hasGatewayToken } from '../services/vpnGatewayToken.js';

/** Ajustes del modulo VPN (solo admin): de momento, solo el token de la puerta de enlace del firewall. */
export const vpnSettingsRouter = Router();
vpnSettingsRouter.use(requireAuth, requireRole('admin'));

/**
 * Huellas para comparar a ojo con lo que muestra la app al confiar en un
 * servidor por primera vez (prompt 12.5, TOFU): `null` cada una por
 * separado si esa pieza todavia no esta configurada (la raiz offline, o
 * VPN_PROFILE_SIGNING_KEY), sin que la falta de una bloquee la otra.
 */
async function loadFingerprints(): Promise<{
  panelKeyFingerprint: FormattedFingerprint | null;
  rootCaFingerprint: FormattedFingerprint | null;
}> {
  const panelKeyFingerprint = isProfileSigningConfigured() ? formatFingerprint(getSignerPublicKeySha256Hex()) : null;
  const rootCert = await getRootCaCert();
  const rootCaFingerprint = rootCert ? formatFingerprint(sha256Hex(rootCert.rawData)) : null;
  return { panelKeyFingerprint, rootCaFingerprint };
}

vpnSettingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [settings, gatewayTokenSet, fingerprints] = await Promise.all([
      getVpnSettings(),
      hasGatewayToken(),
      loadFingerprints(),
    ]);
    res.json({ ...settings, gatewayTokenSet, ...fingerprints });
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
