import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { assertAttrs } from '../lib/radiusDict.js';
import {
  createUser,
  createUsersBulk,
  deleteUser,
  getUser,
  listUsers,
  setUserEnabled,
  setUserGroups,
  updateUser,
} from '../services/radiusUsers.js';
import { disconnectUserSessions } from '../services/coa.js';
import { testAuthentication } from '../services/testAuth.js';
import { getUserActivity } from '../services/analytics.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const attrSchema = z.object({
  attribute: z.string().min(1).max(64),
  op: z.string().max(2).default(':='),
  value: z.string().max(253),
});

const groupSchema = z.object({
  groupname: z.string().min(1).max(64),
  priority: z.coerce.number().int().min(0).default(1),
});

const writeSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().max(256).optional().nullable(),
  passwordType: z.enum(['cleartext', 'nt']).default('cleartext'),
  checks: z.array(attrSchema).default([]),
  replies: z.array(attrSchema).default([]),
  groups: z.array(groupSchema).default([]),
});

/** Rechaza si hay errores de tipo/valor; deja pasar los warnings. */
function checkAttrs(
  checks: { attribute: string; value: string }[],
  replies: { attribute: string; value: string }[],
) {
  const issues = assertAttrs([...checks, ...replies]);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) {
    throw badRequest('Atributos invalidos', errors);
  }
  return issues;
}

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        search: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    res.json(await listUsers(query));
  }),
);

usersRouter.get(
  '/:username',
  asyncHandler(async (req, res) => {
    res.json(await getUser(req.params.username));
  }),
);

usersRouter.get(
  '/:username/activity',
  asyncHandler(async (req, res) => {
    res.json(await getUserActivity(req.params.username));
  }),
);

usersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = writeSchema.parse(req.body);
    const warnings = checkAttrs(input.checks, input.replies);
    const user = await createUser(input);
    await writeAudit(req, 'create', 'user', user.username, { groups: user.groups });
    res.status(201).json({ ...user, warnings });
  }),
);

usersRouter.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const rows = z
      .array(
        z.object({
          username: z.string().min(1).max(64),
          password: z.string().max(256),
          passwordType: z.enum(['cleartext', 'nt']).optional(),
          groups: z.array(z.string().max(64)).optional(),
        }),
      )
      .max(2000)
      .parse(req.body.rows ?? req.body);
    const result = await createUsersBulk(rows);
    await writeAudit(req, 'create', 'user-bulk', `${result.created.length} usuarios`, result);
    res.json(result);
  }),
);

usersRouter.post(
  '/:username/test',
  asyncHandler(async (req, res) => {
    const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
    const result = await testAuthentication(req.params.username, password);
    await writeAudit(req, 'update', 'user-test', req.params.username, {
      result: result.codeName,
    });
    res.json(result);
  }),
);

usersRouter.patch(
  '/:username/enabled',
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await setUserEnabled(req.params.username, enabled);
    await writeAudit(req, 'update', 'user-enabled', req.params.username, { enabled });
    res.json({ username: req.params.username, enabled });
  }),
);

usersRouter.post(
  '/:username/disconnect',
  asyncHandler(async (req, res) => {
    const outcome = await disconnectUserSessions(req.params.username);
    await writeAudit(req, 'disconnect', 'user-sessions', req.params.username, {
      total: outcome.total,
      ok: outcome.results.filter((r) => r.acknowledged).length,
    });
    res.json(outcome);
  }),
);

usersRouter.put(
  '/:username/groups',
  asyncHandler(async (req, res) => {
    const groups = z.array(groupSchema).parse(req.body.groups ?? req.body);
    const result = await setUserGroups(req.params.username, groups);
    await writeAudit(req, 'update', 'user-groups', req.params.username, { groups: result });
    res.json(result);
  }),
);

usersRouter.put(
  '/:username',
  asyncHandler(async (req, res) => {
    const input = writeSchema.parse({ ...req.body, username: req.params.username });
    const warnings = checkAttrs(input.checks, input.replies);
    const user = await updateUser(req.params.username, input);
    await writeAudit(req, 'update', 'user', user.username);
    res.json({ ...user, warnings });
  }),
);

usersRouter.delete(
  '/:username',
  asyncHandler(async (req, res) => {
    await deleteUser(req.params.username);
    await writeAudit(req, 'delete', 'user', req.params.username);
    res.status(204).end();
  }),
);
