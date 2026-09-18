import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { assertAttrs } from '../lib/radiusDict.js';
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  updateGroup,
} from '../services/radiusGroups.js';

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

const attrSchema = z.object({
  attribute: z.string().min(1).max(64),
  op: z.string().max(2).default(':='),
  value: z.string().max(253),
});

const writeSchema = z.object({
  groupname: z.string().min(1).max(64),
  checks: z.array(attrSchema).default([]),
  replies: z.array(attrSchema).default([]),
});

function checkAttrs(input: {
  checks: { attribute: string; value: string }[];
  replies: { attribute: string; value: string }[];
}) {
  const issues = assertAttrs([...input.checks, ...input.replies]);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) throw badRequest('Atributos invalidos', errors);
  return issues;
}

groupsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listGroups());
  }),
);

groupsRouter.get(
  '/:name',
  asyncHandler(async (req, res) => {
    res.json(await getGroup(req.params.name));
  }),
);

groupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = writeSchema.parse(req.body);
    const warnings = checkAttrs(input);
    const group = await createGroup(input);
    await writeAudit(req, 'create', 'group', group.groupname);
    res.status(201).json({ ...group, warnings });
  }),
);

groupsRouter.put(
  '/:name',
  asyncHandler(async (req, res) => {
    const input = writeSchema.parse({ ...req.body, groupname: req.params.name });
    const warnings = checkAttrs(input);
    const group = await updateGroup(req.params.name, input);
    await writeAudit(req, 'update', 'group', group.groupname);
    res.json({ ...group, warnings });
  }),
);

groupsRouter.delete(
  '/:name',
  asyncHandler(async (req, res) => {
    const force = z.coerce.boolean().default(false).parse(req.query.force);
    await deleteGroup(req.params.name, { force });
    await writeAudit(req, 'delete', 'group', req.params.name, { force });
    res.status(204).end();
  }),
);
