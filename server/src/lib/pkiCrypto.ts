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

/**
 * Cifra el .p12 (base64) de un certificado Android mientras espera su
 * descarga de un solo uso (panel_vpn_android_downloads.p12_encrypted): el
 * .p12 ya va protegido con su propia contrasena de 20 caracteres, pero se
 * cifra tambien en reposo con PKI_MASTER_KEY -dos secretos independientes,
 * ninguno de los dos vive en la base de datos- por el mismo motivo que la
 * clave privada de la CA.
 */
export function encryptAndroidP12(p12Base64: string): string {
  return encryptWithMasterKey(requireMasterKeySecret(), p12Base64);
}

/** Descifra lo guardado por `encryptAndroidP12`. Lanza si el dato fue manipulado. */
export function decryptAndroidP12(payload: string): string {
  return decryptWithMasterKey(requireMasterKeySecret(), payload);
}
