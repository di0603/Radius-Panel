import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export type Role = 'admin' | 'operator';

export interface TokenPayload {
  sub: number;
  username: string;
  role: Role;
}

export function signToken(payload: TokenPayload): string {
  const options = { expiresIn: config.jwtExpiresIn } as jwt.SignOptions;
  return jwt.sign(payload, config.jwtSecret, options);
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, config.jwtSecret);
  if (typeof decoded === 'string') throw new Error('Token invalido');
  return {
    sub: Number(decoded.sub),
    username: String(decoded.username),
    role: decoded.role as Role,
  };
}
