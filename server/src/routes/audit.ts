import { Router } from 'express';
import { z } from 'zod';
import type { RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('admin'));

auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        entity: z.string().optional(),
        action: z.string().optional(),
        admin: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const where = `(:entity = '' OR entity = :entity)
      AND (:action = '' OR action = :action)
      AND (:admin = '' OR admin_name = :admin)`;
    const params = {
      entity: q.entity ?? '',
      action: q.action ?? '',
      admin: q.admin ?? '',
      limit: q.limit,
      offset: q.offset,
    };

    const [countRows] = await panelPool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM panel_audit_log WHERE ${where}`,
      params,
    );
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT id, admin_name, action, entity, entity_id, detail, ip, created_at
       FROM panel_audit_log WHERE ${where}
       ORDER BY id DESC LIMIT :limit OFFSET :offset`,
      params,
    );
    res.json({ items: rows, total: Number(countRows[0]?.total ?? 0) });
  }),
);
