import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getAuthFailures,
  getInactiveUsers,
  getOverview,
  getTerminateCauses,
  getTopNas,
  getTopUsers,
} from '../services/reports.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const daysSchema = z.coerce.number().int().min(1).max(365).default(30);

reportsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const days = daysSchema.parse(req.query.days);
    res.json(await getOverview(days));
  }),
);

reportsRouter.get(
  '/top-users',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        days: daysSchema,
        metric: z.enum(['traffic', 'time']).default('traffic'),
        limit: z.coerce.number().int().min(1).max(100).default(10),
      })
      .parse(req.query);
    res.json(await getTopUsers(q));
  }),
);

reportsRouter.get(
  '/terminate-causes',
  asyncHandler(async (req, res) => {
    res.json(await getTerminateCauses(daysSchema.parse(req.query.days)));
  }),
);

reportsRouter.get(
  '/top-nas',
  asyncHandler(async (req, res) => {
    res.json(await getTopNas(daysSchema.parse(req.query.days)));
  }),
);

reportsRouter.get(
  '/inactive-users',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        days: z.coerce.number().int().min(1).max(3650).default(60),
        limit: z.coerce.number().int().min(1).max(500).default(50),
      })
      .parse(req.query);
    res.json(await getInactiveUsers(q));
  }),
);

reportsRouter.get(
  '/auth-failures',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        days: daysSchema,
        limit: z.coerce.number().int().min(1).max(100).default(10),
      })
      .parse(req.query);
    res.json(await getAuthFailures(q));
  }),
);
