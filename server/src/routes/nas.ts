import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { createNas, deleteNas, getNas, listNas, updateNas } from '../services/nas.js';
import { probe } from '../lib/radiusPacket.js';
import { config } from '../config.js';

export const nasRouter = Router();
nasRouter.use(requireAuth);

const writeSchema = z.object({
  nasname: z.string().min(1).max(128),
  shortname: z.string().max(32).optional().nullable(),
  type: z.string().max(30).optional().nullable(),
  ports: z.coerce.number().int().optional().nullable(),
  secret: z.string().min(1).max(60),
  server: z.string().max(64).optional().nullable(),
  community: z.string().max(50).optional().nullable(),
  description: z.string().max(200).optional().nullable(),
});

nasRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listNas());
  }),
);

nasRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getNas(Number(req.params.id)));
  }),
);

nasRouter.get(
  '/:id/probe',
  asyncHandler(async (req, res) => {
    const nas = await getNas(Number(req.params.id));
    const responded = await probe(nas.nasname, config.coa.port, nas.secret, config.coa.timeoutMs);
    res.json({ nasname: nas.nasname, port: config.coa.port, responded });
  }),
);

nasRouter.get(
  '/:id/clients-conf',
  asyncHandler(async (req, res) => {
    const nas = await getNas(Number(req.params.id));
    const name = nas.shortname || nas.nasname.replace(/\W+/g, '_');
    const conf =
      `client ${name} {\n` +
      `    ipaddr = ${nas.nasname}\n` +
      `    secret = ${nas.secret}\n` +
      (nas.shortname ? `    shortname = ${nas.shortname}\n` : '') +
      (nas.type ? `    nas_type = ${nas.type}\n` : '') +
      `}\n`;
    res.type('text/plain').send(conf);
  }),
);

nasRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const nas = await createNas(writeSchema.parse(req.body));
    await writeAudit(req, 'create', 'nas', nas.id, { nasname: nas.nasname });
    res.status(201).json(nas);
  }),
);

nasRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const nas = await updateNas(Number(req.params.id), writeSchema.parse(req.body));
    await writeAudit(req, 'update', 'nas', nas.id, { nasname: nas.nasname });
    res.json(nas);
  }),
);

nasRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteNas(Number(req.params.id));
    await writeAudit(req, 'delete', 'nas', req.params.id);
    res.status(204).end();
  }),
);
