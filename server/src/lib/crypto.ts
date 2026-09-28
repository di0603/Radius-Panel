import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

/**
 * Clave AES derivada de JWT_SECRET. Si cambias JWT_SECRET, los secretos TOTP
 * guardados dejan de poder descifrarse y hay que volver a dar de alta el 2FA.
 */
const key = scryptSync(config.jwtSecret, 'radius-panel-secret-box-v1', 32);

/**
 * Cifra `plain` con AES-256-GCM bajo la clave dada. Formato: iv.tag.datos
 * (base64url). Primitiva generica: `encryptSecret`/`decryptSecret` la usan
 * con la clave derivada de JWT_SECRET; otros modulos (p.ej. la PKI de la VPN,
 * ver lib/pkiCrypto.ts) la usan con una clave distinta.
 */
export function boxWithKey(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join('.');
}

/** Descifra lo guardado por `boxWithKey` con la misma clave. Lanza si el dato fue manipulado. */
export function unboxWithKey(key: Buffer, payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split('.');
  if (!ivPart || !tagPart || !dataPart) throw new Error('Secreto cifrado con formato invalido');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Cifra un secreto para guardarlo en la BD, con la clave derivada de JWT_SECRET. */
export function encryptSecret(plain: string): string {
  return boxWithKey(key, plain);
}

/** Descifra lo guardado por `encryptSecret`. Lanza si el dato fue manipulado. */
export function decryptSecret(payload: string): string {
  return unboxWithKey(key, payload);
}

/** Token opaco de 256 bits para refresh tokens. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash con el que se guardan los refresh tokens (nunca se guarda el token en claro). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Comparacion en tiempo constante de dos cadenas hex del mismo tamano. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
