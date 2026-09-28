import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { issueAndroidCertificate } from '../services/androidCert.js';
import { buildDevicePackage } from '../services/vpnClientPackages.js';
import {
  NAME_PART_RE,
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

const namePart = (label: string) =>
  z.string().regex(NAME_PART_RE, `${label}: solo minusculas, numeros y guiones, 2-32 caracteres`);

const createSchema = z.object({
  ownerUser: namePart('ownerUser'),
  deviceLabel: namePart('deviceLabel'),
  ownerName: z.string().max(128).nullable().optional(),
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
      ownerUser: input.ownerUser,
      deviceLabel: input.deviceLabel,
      ownerName: input.ownerName ?? null,
      platform: input.platform,
      tunnelMode,
      notes: input.notes ?? null,
      certDays: input.certDays ?? null,
      renewAfterDays: input.renewAfterDays ?? null,
    });
    await writeAudit(req, 'create', 'vpn_device', device.username, {
      platform: device.platform,
      framedIp: device.framedIp,
    });
    res.status(201).json(device);
  }),
);

vpnDevicesRouter.get(
  '/:username/package',
  asyncHandler(async (req, res) => {
    const pkg = await buildDevicePackage(req.params.username);
    res.set('Content-Disposition', `attachment; filename="${pkg.filename}"`);
    res.type(pkg.contentType).send(pkg.buffer);
  }),
);

vpnDevicesRouter.post(
  '/:username/android-cert',
  asyncHandler(async (req, res) => {
    const result = await issueAndroidCertificate(req.params.username, req.auth!.sub);
    // Nunca se audita la contrasena del .p12 ni el token de descarga en claro.
    await writeAudit(req, 'create', 'vpn_android_cert', req.params.username, {
      expiresAt: result.expiresAt,
    });
    res.status(201).json(result);
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
