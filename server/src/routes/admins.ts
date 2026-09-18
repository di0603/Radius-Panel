import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { createAdmin, deleteAdmin, listAdmins, updateAdmin } from '../services/admins.js';
import { unlockAdmin } from '../services/auth.js';

export const adminsRouter = Router();
adminsRouter.use(requireAuth, requireRole('admin'));

adminsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listAdmins());
  }),
);

adminsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        username: z.string().min(1).max(64),
        password: z.string().min(8).max(256),
        role: z.enum(['admin', 'operator']).default('operator'),
      })
      .parse(req.body);
    const admin = await createAdmin(input);
    await writeAudit(req, 'create', 'admin', admin.id, {
      username: admin.username,
      role: admin.role,
    });
    res.status(201).json(admin);
  }),
);

adminsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        password: z.string().min(8).max(256).optional(),
        role: z.enum(['admin', 'operator']).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    const admin = await updateAdmin(Number(req.params.id), input, req.auth!.sub);
    await writeAudit(req, 'update', 'admin', admin.id, { role: admin.role, active: admin.active });
    res.json(admin);
  }),
);

adminsRouter.post(
  '/:id/unlock',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Id invalido');
    await unlockAdmin(id);
    await writeAudit(req, 'update', 'admin', id, { unlocked: true });
    res.json({ ok: true });
  }),
);

adminsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteAdmin(Number(req.params.id), req.auth!.sub);
    await writeAudit(req, 'delete', 'admin', req.params.id);
    res.status(204).end();
  }),
);
