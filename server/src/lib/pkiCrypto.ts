import { scryptSync } from 'node:crypto';
import { config } from '../config.js';
import { boxWithKey, unboxWithKey } from './crypto.js';

/**
 * Cifra la clave privada de la CA intermedia con una clave derivada de
 * PKI_MASTER_KEY (nunca de JWT_SECRET): es material mucho mas sensible que un
 * secreto TOTP, con una vida util mucho mas larga, asi que usa un secreto
 * propio en vez de compartir el de las sesiones del panel.
 */
export function deriveMasterKey(masterKeySecret: string): Buffer {
  return scryptSync(masterKeySecret, 'radius-panel-pki-key-box-v1', 32);
}

export function encryptWithMasterKey(masterKeySecret: string, plain: string): string {
  return boxWithKey(deriveMasterKey(masterKeySecret), plain);
}

export function decryptWithMasterKey(masterKeySecret: string, payload: string): string {
  return unboxWithKey(deriveMasterKey(masterKeySecret), payload);
}

function requireMasterKeySecret(): string {
  if (!config.pki.masterKey) {
    throw new Error(
      'Falta PKI_MASTER_KEY en server/.env: hace falta para cifrar/descifrar la clave privada de la CA.',
    );
  }
  return config.pki.masterKey;
}

/** Cifra el PEM de una clave privada de CA para guardarlo en panel_pki_ca. */
export function encryptPkiPrivateKey(privateKeyPem: string): string {
  return encryptWithMasterKey(requireMasterKeySecret(), privateKeyPem);
}

/** Descifra lo guardado por `encryptPkiPrivateKey`. Lanza si el dato fue manipulado. */
export function decryptPkiPrivateKey(payload: string): string {
  return decryptWithMasterKey(requireMasterKeySecret(), payload);
}
