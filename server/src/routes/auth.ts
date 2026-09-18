import { Router, type CookieOptions, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { sign2faTicket, signToken, verify2faTicket } from '../lib/jwt.js';
import { asyncHandler, badRequest, locked, unauthorized } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { panelPool } from '../db/pools.js';
import {
  clearFailedLogins,
  confirmTotp,
  countRecentFailures,
  disableTotp,
  findAdminById,
  findAdminByUsername,
  issueRefreshToken,
  listSessions,
  lockRemainingMinutes,
  recordLoginAttempt,
  registerFailedLogin,
  revokeAllSessions,
  revokeRefreshToken,
  revokeSessionById,
  rotateRefreshToken,
  startTotpEnrollment,
  verifyTotpCode,
  type AdminRow,
} from '../services/auth.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'rp_refresh';

/** La cookie solo viaja a /api/auth: el resto de la API usa el access token. */
function cookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: '/api/auth',
    maxAge: maxAgeMs,
  };
}

function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(expiresAt.getTime() - Date.now()));
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}

function clientIp(req: Request): string {
  return req.ip ?? '';
}

function userAgent(req: Request): string {
  return String(req.headers['user-agent'] ?? '');
}

function publicUser(admin: AdminRow) {
  return {
    id: Number(admin.id),
    username: admin.username,
    role: admin.role,
    totpEnabled: Number(admin.totp_enabled) === 1,
  };
}

/** Emite access + refresh y deja la cookie puesta. */
async function completeLogin(req: Request, res: Response, admin: AdminRow) {
  await clearFailedLogins(Number(admin.id));
  const refresh = await issueRefreshToken(Number(admin.id), clientIp(req), userAgent(req));
  setRefreshCookie(res, refresh.token, refresh.expiresAt);
  const token = signToken({
    sub: Number(admin.id),
    username: admin.username,
    role: admin.role,
  });
  await recordLoginAttempt(admin.username, clientIp(req), true);
  req.auth = { sub: Number(admin.id), username: admin.username, role: admin.role };
  await writeAudit(req, 'login', 'session', admin.username);
  res.json({ token, user: publicUser(admin) });
}

/* -------------------------------- Login -------------------------------- */

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
    const ip = clientIp(req);
    const genericError = unauthorized('Usuario o contrasena incorrectos');

    // Rate-limit por cuenta: frena la fuerza bruta repartida entre muchas IP.
    if ((await countRecentFailures(username)) >= config.login.maxAttempts) {
      await recordLoginAttempt(username, ip, false, 'rate-limited');
      throw locked(
        `Demasiados intentos fallidos para "${username}". Espera ${config.login.lockMinutes} minutos.`,
      );
    }

    const admin = await findAdminByUsername(username);
    if (!admin || !admin.active) {
      await recordLoginAttempt(username, ip, false, admin ? 'inactive' : 'unknown-user');
      throw genericError;
    }

    const lockedMinutes = lockRemainingMinutes(admin);
    if (lockedMinutes > 0) {
      await recordLoginAttempt(username, ip, false, 'locked');
      throw locked(`Cuenta bloqueada. Vuelve a intentarlo en ${lockedMinutes} minuto(s).`);
    }

    if (!(await verifyPassword(password, admin.password_hash))) {
      await registerFailedLogin(Number(admin.id));
      await recordLoginAttempt(username, ip, false, 'bad-password');
      throw genericError;
    }

    if (Number(admin.totp_enabled) === 1) {
      res.json({ twoFactorRequired: true, ticket: sign2faTicket(Number(admin.id)) });
      return;
    }

    await completeLogin(req, res, admin);
  }),
);

const twoFactorSchema = z.object({
  ticket: z.string().min(1),
  code: z.string().min(6).max(10),
});

authRouter.post(
  '/login/2fa',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { ticket, code } = twoFactorSchema.parse(req.body);

    let adminId: number;
    try {
      adminId = verify2faTicket(ticket);
    } catch {
      throw unauthorized('El proceso de acceso ha caducado, vuelve a empezar');
    }

    const admin = await findAdminById(adminId);
    if (!admin || !admin.active || !admin.totp_secret) throw unauthorized('Acceso no valido');

    if (!(await verifyTotpCode(admin.totp_secret, code))) {
      await registerFailedLogin(adminId);
      await recordLoginAttempt(admin.username, clientIp(req), false, 'bad-totp');
      throw unauthorized('Codigo incorrecto');
    }

    await completeLogin(req, res, admin);
  }),
);

/* ------------------------- Renovacion y cierre ------------------------- */

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw unauthorized('No hay sesion que renovar');

    const result = await rotateRefreshToken(token, clientIp(req), userAgent(req));
    if (!result.ok) {
      clearRefreshCookie(res);
      if (result.reason === 'reused') {
        throw unauthorized('Sesion revocada por seguridad, vuelve a entrar');
      }
      throw unauthorized('Sesion caducada');
    }

    const admin = await findAdminById(result.adminId);
    if (!admin || !admin.active) {
      clearRefreshCookie(res);
      throw unauthorized('La cuenta ya no esta activa');
    }

    setRefreshCookie(res, result.token, result.expiresAt);
    res.json({
      token: signToken({ sub: Number(admin.id), username: admin.username, role: admin.role }),
      user: publicUser(admin),
    });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (token) await revokeRefreshToken(token);
    clearRefreshCookie(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const admin = await findAdminById(Number(req.auth?.sub));
    if (!admin || !admin.active) throw unauthorized('La cuenta ya no esta activa');
    res.json({ user: publicUser(admin) });
  }),
);

/* ------------------------- Sesiones del panel -------------------------- */

authRouter.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ items: await listSessions(Number(req.auth?.sub)) });
  }),
);

authRouter.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Id de sesion invalido');
    const done = await revokeSessionById(id, Number(req.auth?.sub));
    await writeAudit(req, 'delete', 'panel-session', id);
    res.json({ revoked: done });
  }),
);

authRouter.delete(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const count = await revokeAllSessions(Number(req.auth?.sub));
    clearRefreshCookie(res);
    await writeAudit(req, 'delete', 'panel-session', 'all', { count });
    res.json({ revoked: count });
  }),
);

/* ---------------------------- Contrasena ------------------------------- */

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'La nueva contrasena debe tener al menos 8 caracteres').max(256),
});

authRouter.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const admin = await findAdminById(Number(req.auth?.sub));
    if (!admin) throw unauthorized();
    if (!(await verifyPassword(currentPassword, admin.password_hash))) {
      throw unauthorized('La contrasena actual no es correcta');
    }

    await panelPool.query(
      `UPDATE panel_admins SET password_hash = :hash, password_changed_at = NOW() WHERE id = :id`,
      { id: admin.id, hash: await hashPassword(newPassword) },
    );
    // Cambiar la contrasena echa al resto de sesiones.
    await revokeAllSessions(Number(admin.id));
    const refresh = await issueRefreshToken(Number(admin.id), clientIp(req), userAgent(req));
    setRefreshCookie(res, refresh.token, refresh.expiresAt);
    await writeAudit(req, 'update', 'admin', admin.username, { passwordChanged: true });
    res.json({ ok: true });
  }),
);

/* -------------------------------- 2FA ---------------------------------- */

authRouter.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const admin = await findAdminById(Number(req.auth?.sub));
    if (!admin) throw unauthorized();
    const enrollment = await startTotpEnrollment(Number(admin.id), admin.username);
    res.json({
      secret: enrollment.secret,
      otpauthUrl: enrollment.otpauthUrl,
      qrDataUrl: await QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 220 }),
    });
  }),
);

const codeSchema = z.object({ code: z.string().min(6).max(10) });

authRouter.post(
  '/2fa/confirm',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = codeSchema.parse(req.body);
    const admin = await findAdminById(Number(req.auth?.sub));
    if (!admin?.totp_secret) throw badRequest('Primero genera un secreto con /2fa/setup');
    if (!(await verifyTotpCode(admin.totp_secret, code))) throw badRequest('Codigo incorrecto');

    await confirmTotp(Number(admin.id));
    await writeAudit(req, 'update', 'admin', admin.username, { totp: 'enabled' });
    res.json({ enabled: true });
  }),
);

const disableSchema = z.object({ password: z.string().min(1) });

authRouter.delete(
  '/2fa',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { password } = disableSchema.parse(req.body);
    const admin = await findAdminById(Number(req.auth?.sub));
    if (!admin) throw unauthorized();
    if (!(await verifyPassword(password, admin.password_hash))) {
      throw unauthorized('Contrasena incorrecta');
    }

    await disableTotp(Number(admin.id));
    await writeAudit(req, 'update', 'admin', admin.username, { totp: 'disabled' });
    res.json({ enabled: false });
  }),
);
