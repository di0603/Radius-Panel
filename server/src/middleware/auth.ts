import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type Role, type TokenPayload } from '../lib/jwt.js';
import { unauthorized, forbidden } from '../lib/http.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: TokenPayload;
      id?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized('Falta el token Bearer'));
  try {
    req.auth = verifyToken(token);
    next();
  } catch {
    next(unauthorized('Token invalido o caducado'));
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role))
      return next(forbidden('Necesitas rol: ' + roles.join(' o ')));
    next();
  };
}
