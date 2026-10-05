import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { issueAndroidCertificate } from '../services/androidCert.js';
import { ACCESS_PROFILES } from '../services/vpnAccessProfiles.js';
import { addDeviceRule, deleteDeviceRule, listDeviceRules } from '../services/vpnDeviceRules.js';
import { buildDevicePackage } from '../services/vpnClientPackages.js';
import {
  NAME_PART_RE,
  changeDeviceProfile,
  createDevice,
  decommissionDevice,
  generateEnrollToken,
  getDeviceDetail,
  listDevices,
  revokeDeviceCertificate,
  setDeviceEnabled,
  setDeviceOverrides,
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
  accessProfile: z.enum(ACCESS_PROFILES).optional(),
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
      accessProfile: input.accessProfile,
      notes: input.notes ?? null,
      certDays: input.certDays ?? null,
      renewAfterDays: input.renewAfterDays ?? null,
    });
    await writeAudit(req, 'create', 'vpn_device', device.username, {
      platform: device.platform,
      framedIp: device.framedIp,
      accessProfile: device.accessProfile,
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
    // Nunca se audita el token en claro ni el perfil firmado (lo lleva
    // embebido), solo que se genero uno.
    await writeAudit(req, 'create', 'vpn_enroll_token', req.params.username, {
      expiresAt: result.expiresAt,
      profileGenerated: result.profile !== null,
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

vpnDevicesRouter.patch(
  '/:username/access-profile',
  asyncHandler(async (req, res) => {
    const { accessProfile } = z.object({ accessProfile: z.enum(ACCESS_PROFILES) }).parse(req.body);
    const result = await changeDeviceProfile(req.params.username, accessProfile);
    if (result.changed) {
      // Decision de seguridad (cambia lo que el dispositivo puede alcanzar): quien, cuando
      // (la fila de auditoria lleva fecha y administrador), antes/despues y si la sesion
      // activa se pudo desconectar.
      await writeAudit(req, 'update', 'vpn_device_access_profile', req.params.username, {
        before: result.before,
        after: result.after,
        disconnect: result.disconnect,
      });
    }
    res.json(result);
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

/* -------------------------- Permisos de red (firewall) ------------------------- */

const addRuleSchema = z.object({
  kind: z.enum(['internet', 'lan', 'custom']),
  destCidr: z.string().max(45).nullable().optional(),
  protocol: z.enum(['tcp', 'udp', 'any']).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
});

vpnDevicesRouter.get(
  '/:username/rules',
  asyncHandler(async (req, res) => {
    res.json(await listDeviceRules(req.params.username));
  }),
);

vpnDevicesRouter.post(
  '/:username/rules',
  asyncHandler(async (req, res) => {
    const input = addRuleSchema.parse(req.body);
    const rule = await addDeviceRule(req.params.username, input, req.auth!.sub);
    await writeAudit(req, 'create', 'vpn_device_rule', req.params.username, {
      kind: rule.kind,
      destCidr: rule.destCidr,
      protocol: rule.protocol,
      port: rule.port,
    });
    res.status(201).json(rule);
  }),
);

vpnDevicesRouter.delete(
  '/:username/rules/:ruleId',
  asyncHandler(async (req, res) => {
    const ruleId = Number(req.params.ruleId);
    await deleteDeviceRule(req.params.username, ruleId);
    await writeAudit(req, 'delete', 'vpn_device_rule', req.params.username, { ruleId });
    res.json({ ok: true });
  }),
);

const overridesSchema = z.object({
  allowRadiusHost: z.boolean().optional(),
  allowMariadbHost: z.boolean().optional(),
});

vpnDevicesRouter.patch(
  '/:username/overrides',
  asyncHandler(async (req, res) => {
    const input = overridesSchema.parse(req.body);
    await setDeviceOverrides(req.params.username, input);
    // Decision de seguridad real (permite lo que por defecto esta siempre
    // prohibido): se audita completa, no solo que "se actualizo algo".
    await writeAudit(req, 'update', 'vpn_device_overrides', req.params.username, input);
    res.json({ ok: true });
  }),
);
