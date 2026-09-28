import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import {
  createDevice,
  decommissionDevice,
  generateEnrollToken,
  getDeviceDetail,
  listDevices,
  revokeDeviceCertificate,
  setDeviceEnabled,
} from '../services/vpnDevices.js';

/**
 * Alta y gestion de dispositivos VPN. Solo rol admin: crea usuarios RADIUS
 * (IP fija, grupo vpn) y su ficha en el panel.
 */
export const vpnDevicesRouter = Router();
vpnDevicesRouter.use(requireAuth, requireRole('admin'));

const NAME_RE = /^[a-z0-9-]{3,32}$/;

const createSchema = z.object({
  name: z.string().regex(NAME_RE, 'Solo minusculas, numeros y guiones, 3-32 caracteres'),
  owner: z.string().max(255).nullable().optional(),
  platform: z.enum(['windows', 'android', 'linux']),
  tunnelMode: z.enum(['full', 'split']).optional(),
  notes: z.string().max(2000).nullable().optional(),
  certDays: z.number().int().positive().max(3650).nullable().optional(),
  renewAfterDays: z.number().int().positive().max(3650).nullable().optional(),
});

vpnDevicesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listDevices());
  }),
);

vpnDevicesRouter.get(
  '/:username',
  asyncHandler(async (req, res) => {
    res.json(await getDeviceDetail(req.params.username));
  }),
);

vpnDevicesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    // Split por defecto solo para linux: suele ser un VPS que no necesita
    // enrutar todo su trafico por la VPN; el resto va en tunel completo.
    const tunnelMode = input.tunnelMode ?? (input.platform === 'linux' ? 'split' : 'full');
    const device = await createDevice({
      name: input.name,
      owner: input.owner ?? null,
      platform: input.platform,
      tunnelMode,
      notes: input.notes ?? null,
      certDays: input.certDays ?? null,
      renewAfterDays: input.renewAfterDays ?? null,
      createdBy: req.auth!.sub,
    });
    await writeAudit(req, 'create', 'vpn_device', device.username, {
      platform: device.platform,
      framedIp: device.framedIp,
    });
    res.status(201).json(device);
  }),
);

vpnDevicesRouter.post(
  '/:username/enroll-token',
  asyncHandler(async (req, res) => {
    const result = await generateEnrollToken(req.params.username, req.auth!.sub);
    // Nunca se audita el token en claro, solo que se genero uno.
    await writeAudit(req, 'create', 'vpn_enroll_token', req.params.username, {
      expiresAt: result.expiresAt,
    });
    res.status(201).json(result);
  }),
);

vpnDevicesRouter.patch(
  '/:username/enabled',
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await setDeviceEnabled(req.params.username, enabled);
    await writeAudit(req, 'update', 'vpn_device', req.params.username, { enabled });
    res.json({ ok: true });
  }),
);

vpnDevicesRouter.post(
  '/:username/revoke',
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(1).max(255) }).parse(req.body);
    await revokeDeviceCertificate(req.params.username, reason);
    await writeAudit(req, 'update', 'vpn_device_certificate', req.params.username, { reason });
    res.json({ ok: true });
  }),
);

vpnDevicesRouter.delete(
  '/:username',
  asyncHandler(async (req, res) => {
    await decommissionDevice(req.params.username);
    await writeAudit(req, 'delete', 'vpn_device', req.params.username);
    res.json({ ok: true });
  }),
);
