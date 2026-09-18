import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { RowDataPacket } from 'mysql2';
import { panelPool } from '../db/pools.js';
import { verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { asyncHandler, unauthorized } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso, prueba de nuevo en unos minutos' },
});

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const [rows] = await panelPool.query<RowDataPacket[]>(
      `SELECT id, username, password_hash, role, active FROM panel_admins WHERE username = :u`,
      { u: username },
    );
    const admin = rows[0];
    if (!admin || !admin.active) throw unauthorized('Usuario o contrasena incorrectos');

    const ok = await verifyPassword(password, admin.password_hash as string);
    if (!ok) throw unauthorized('Usuario o contrasena incorrectos');

    await panelPool.query(`UPDATE panel_admins SET last_login_at = NOW() WHERE id = :id`, {
      id: admin.id,
    });

    const token = signToken({
      sub: Number(admin.id),
      username: admin.username as string,
      role: admin.role as 'admin' | 'operator',
    });
    await writeAudit(req, 'login', 'session', admin.username as string);

    res.json({
      token,
      user: { id: Number(admin.id), username: admin.username, role: admin.role },
    });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.auth });
  }),
);
