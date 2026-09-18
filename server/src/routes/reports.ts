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
import {
  getAnomalies,
  getHourlyHeatmap,
  getNasStats,
  getPeakConcurrency,
  getPeriodComparison,
  getSessionDurations,
} from '../services/analytics.js';

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

/* ------------------------------ Analitica ------------------------------ */

reportsRouter.get(
  '/heatmap',
  asyncHandler(async (req, res) => {
    res.json(await getHourlyHeatmap(daysSchema.parse(req.query.days)));
  }),
);

reportsRouter.get(
  '/concurrency',
  asyncHandler(async (req, res) => {
    // El calculo cruza cada dia con 24 horas: se limita el rango a proposito.
    const days = z.coerce.number().int().min(1).max(90).default(30).parse(req.query.days);
    res.json(await getPeakConcurrency(days));
  }),
);

reportsRouter.get(
  '/nas-stats',
  asyncHandler(async (req, res) => {
    res.json(await getNasStats(daysSchema.parse(req.query.days)));
  }),
);

reportsRouter.get(
  '/session-durations',
  asyncHandler(async (req, res) => {
    res.json(await getSessionDurations(daysSchema.parse(req.query.days)));
  }),
);

reportsRouter.get(
  '/period-comparison',
  asyncHandler(async (req, res) => {
    res.json(await getPeriodComparison(daysSchema.parse(req.query.days)));
  }),
);

reportsRouter.get(
  '/anomalies',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        days: daysSchema,
        limit: z.coerce.number().int().min(1).max(50).default(10),
      })
      .parse(req.query);
    res.json(await getAnomalies(q.days, q.limit));
  }),
);
