import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import {
  ACCESS_PROFILES,
  ACCESS_PROFILE_INFO,
  INFRASTRUCTURE_WARNING,
  RESERVED_HOSTS,
  dhcpFromConfig,
  getProfileRanges,
  setProfileRanges,
  type ProfileRanges,
} from '../services/vpnAccessProfiles.js';
import {
  RESTRICTED_PROTOCOLS,
  addRestrictedDestination,
  deleteRestrictedDestination,
  listRestrictedDestinations,
  updateRestrictedDestination,
} from '../services/vpnRestrictedList.js';
import { generateProfilesConfig } from '../services/vpnProfilesNft.js';
import { getVpnSettings } from '../services/vpnSettings.js';

/**
 * Perfiles de acceso VPN (prompt 12.14): rangos de IP por perfil, lista
 * global de destinos de los perfiles restringidos y descarga del
 * vpn-profiles.nft. Solo rol admin. Cada cambio se audita con antes/despues.
 * Nada de aqui ejecuta nada en la VM VPN: el fichero se descarga y lo aplica
 * a mano deploy/vpn-gateway-apply-profiles.sh.
 */
export const vpnProfilesRouter = Router();
vpnProfilesRouter.use(requireAuth, requireRole('admin'));

vpnProfilesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [ranges, destinations, settings] = await Promise.all([
      getProfileRanges(),
      listRestrictedDestinations(),
      getVpnSettings(),
    ]);
    res.json({
      profiles: ACCESS_PROFILES.map((p) => ACCESS_PROFILE_INFO[p]),
      infrastructureWarning: INFRASTRUCTURE_WARNING,
      ranges,
      destinations,
      lanCidr: settings.lanCidr,
      dhcp: dhcpFromConfig(),
      reservedHosts: RESERVED_HOSTS,
      egressInterface: config.vpnProfiles.egressInterface ?? null,
    });
  }),
);

const rangeSchema = z.object({
  rangeStart: z.string().trim().max(15).nullable(),
  rangeEnd: z.string().trim().max(15).nullable(),
});
const rangesSchema = z.object({
  ranges: z.object({
    lan_restricted: rangeSchema,
    lan_full: rangeSchema,
    internet_only: rangeSchema,
    internet_lan_restricted: rangeSchema,
    internet_lan_full: rangeSchema,
  }),
});

vpnProfilesRouter.put(
  '/ranges',
  asyncHandler(async (req, res) => {
    const { ranges } = rangesSchema.parse(req.body);
    // Cadena vacia de la interfaz = sin rango.
    const next = Object.fromEntries(
      ACCESS_PROFILES.map((p) => [
        p,
        { rangeStart: ranges[p].rangeStart || null, rangeEnd: ranges[p].rangeEnd || null },
      ]),
    ) as ProfileRanges;
    const { before, after } = await setProfileRanges(next, req.auth!.sub);
    await writeAudit(req, 'update', 'vpn_profile_ranges', 'all', { before, after });
    res.json({ ranges: after });
  }),
);

const destinationSchema = z.object({
  destCidr: z.string().trim().min(1).max(18),
  protocol: z.enum(RESTRICTED_PROTOCOLS),
  ports: z.string().trim().max(64).nullable().optional(),
  comment: z.string().max(128).nullable().optional(),
});

vpnProfilesRouter.post(
  '/destinations',
  asyncHandler(async (req, res) => {
    const input = destinationSchema.parse(req.body);
    const entry = await addRestrictedDestination(input, req.auth!.sub);
    await writeAudit(req, 'create', 'vpn_restricted_destination', entry.id, {
      before: null,
      after: entry,
    });
    res.status(201).json(entry);
  }),
);

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw badRequest('Identificador de entrada invalido');
  return id;
}

vpnProfilesRouter.put(
  '/destinations/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id!);
    const input = destinationSchema.parse(req.body);
    const { before, after } = await updateRestrictedDestination(id, input);
    await writeAudit(req, 'update', 'vpn_restricted_destination', id, { before, after });
    res.json(after);
  }),
);

vpnProfilesRouter.delete(
  '/destinations/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id!);
    const before = await deleteRestrictedDestination(id);
    await writeAudit(req, 'delete', 'vpn_restricted_destination', id, { before, after: null });
    res.json({ ok: true });
  }),
);

/** Descarga de vpn-profiles.nft (se aplica a mano en la VM VPN, no desde el panel). */
vpnProfilesRouter.get(
  '/nft',
  asyncHandler(async (req, res) => {
    const nft = await generateProfilesConfig();
    await writeAudit(req, 'create', 'vpn_profiles_nft', 'download');
    res
      .set('Content-Disposition', 'attachment; filename="vpn-profiles.nft"')
      .type('text/plain')
      .send(nft);
  }),
);
