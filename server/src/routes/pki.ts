import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import {
  cancelPendingIntermediate,
  generateIntermediateCsr,
  getPkiStatus,
  importIntermediate,
  regenerateCrl,
} from '../services/pki.js';

/**
 * Gestion de la CA intermedia de la VPN. Solo rol admin: la PKI de dispositivo
 * es material sensible (nunca se devuelve ni se audita la clave privada).
 */
export const pkiRouter = Router();
pkiRouter.use(requireAuth, requireRole('admin'));

pkiRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await getPkiStatus());
  }),
);

pkiRouter.post(
  '/intermediate',
  asyncHandler(async (req, res) => {
    const input = z.object({ subjectCn: z.string().min(1).max(255) }).parse(req.body);
    const result = await generateIntermediateCsr({
      subjectCn: input.subjectCn,
      createdBy: req.auth!.sub,
    });
    await writeAudit(req, 'create', 'vpn_pki_intermediate', result.id, {
      subjectCn: result.subjectCn,
    });
    res.status(201).json(result);
  }),
);

pkiRouter.delete(
  '/intermediate/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Id invalido');
    await cancelPendingIntermediate(id);
    await writeAudit(req, 'delete', 'vpn_pki_intermediate', id);
    res.status(204).end();
  }),
);

pkiRouter.post(
  '/intermediate/:id/import',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Id invalido');
    const input = z
      .object({ certPem: z.string().min(1), rootCertPem: z.string().min(1) })
      .parse(req.body);
    const result = await importIntermediate(id, input);
    await writeAudit(req, 'update', 'vpn_pki_intermediate', id, {
      status: result.status,
      serial: result.serial,
    });
    res.json(result);
  }),
);

pkiRouter.post(
  '/intermediate/:id/regenerate-crl',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Id invalido');
    await regenerateCrl(id);
    await writeAudit(req, 'update', 'vpn_pki_crl', id);
    res.json(await getPkiStatus());
  }),
);
