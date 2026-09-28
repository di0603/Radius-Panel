// @peculiar/x509 no publica "exports" en su package.json, asi que Node siempre
// carga su build CJS (usa tsyringe internamente para el motor de crypto), que
// exige el polyfill de reflect-metadata cargado antes de importar el paquete.
import 'reflect-metadata';
import { createHash, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

/**
 * @peculiar/x509 no trae un motor WebCrypto por defecto: hay que registrar
 * uno antes de llamar a cualquier metodo estatico (create/verify/...), si no
 * lanza "no se ha establecido ningun proveedor por defecto". Node >= 20 ya
 * trae WebCrypto integrado (`node:crypto`.webcrypto), asi que no hace falta
 * ninguna dependencia extra para esto.
 */
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export { x509 };

/** Algoritmo de firma para toda la PKI de la VPN: RSA con SHA-256. */
export const RSA_SIGNING_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** Genera un par de claves RSA para una CA o un certificado de dispositivo. */
export async function generateRsaKeyPair(modulusLength = 4096): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(
    { ...RSA_SIGNING_ALGORITHM, modulusLength, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

/** Exporta una clave privada RSA en PEM (PKCS8), para cifrarla y guardarla. */
export async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, x509.PemConverter.PrivateKeyTag);
}

/** Reimporta una clave privada RSA (PKCS8 PEM) previamente exportada, solo para firmar. */
export async function importRsaPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const der = x509.PemConverter.decodeFirst(pem);
  return webcrypto.subtle.importKey('pkcs8', der, RSA_SIGNING_ALGORITHM, false, ['sign']);
}

/** SHA-256 en hexadecimal de un buffer (p.ej. la SubjectPublicKeyInfo de un certificado/CSR). */
export function sha256Hex(data: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}
