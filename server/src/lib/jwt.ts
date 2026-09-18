import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export type Role = 'admin' | 'operator';

export interface TokenPayload {
  sub: number;
  username: string;
  role: Role;
}

/** Token de acceso: vida corta, viaja en la cabecera Authorization. */
export function signToken(payload: TokenPayload): string {
  const options = { expiresIn: config.accessTokenTtl } as jwt.SignOptions;
  return jwt.sign({ ...payload, typ: 'access' }, config.jwtSecret, options);
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, config.jwtSecret);
  if (typeof decoded === 'string') throw new Error('Token invalido');
  if (decoded.typ && decoded.typ !== 'access') throw new Error('Tipo de token incorrecto');
  return {
    sub: Number(decoded.sub),
    username: String(decoded.username),
    role: decoded.role as Role,
  };
}

/**
 * Token intermedio del segundo factor: solo sirve para canjear un codigo TOTP,
 * no da acceso a la API. Vive 5 minutos.
 */
export function sign2faTicket(adminId: number): string {
  return jwt.sign({ sub: adminId, typ: '2fa' }, config.jwtSecret, { expiresIn: '5m' });
}

export function verify2faTicket(ticket: string): number {
  const decoded = jwt.verify(ticket, config.jwtSecret);
  if (typeof decoded === 'string' || decoded.typ !== '2fa') {
    throw new Error('Ticket de 2FA invalido');
  }
  return Number(decoded.sub);
}
