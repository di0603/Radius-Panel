import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { listActiveSessions, listSessionHistory } from '../services/accounting.js';
import { disconnectSession } from '../services/coa.js';
import { config } from '../config.js';

export const sessionsRouter = Router();
sessionsRouter.use(requireAuth);

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

sessionsRouter.get(
  '/active',
  asyncHandler(async (req, res) => {
    const q = pageSchema
      .extend({ search: z.string().optional(), nasipaddress: z.string().optional() })
      .parse(req.query);
    res.json({ ...(await listActiveSessions(q)), coaEnabled: config.coa.enabled });
  }),
);

sessionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.coerce.number().int().min(0).optional(),
        username: z.string().optional(),
        nasipaddress: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.query);
    res.json(await listSessionHistory(q));
  }),
);

sessionsRouter.post(
  '/:acctuniqueid/disconnect',
  asyncHandler(async (req, res) => {
    const outcome = await disconnectSession(req.params.acctuniqueid);
    await writeAudit(req, 'disconnect', 'session', req.params.acctuniqueid, outcome);
    res.json(outcome);
  }),
);
