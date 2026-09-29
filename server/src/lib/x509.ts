// @peculiar/x509 no publica "exports" en su package.json, asi que Node siempre
// carga su build CJS (usa tsyringe internamente para el motor de crypto), que
// exige el polyfill de reflect-metadata cargado antes de importar el paquete.
import 'reflect-metadata';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
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

/**
 * Algoritmo de firma de la CA intermedia (y de sus CRL): ECDSA P-384 con
 * SHA-384, igual que la raiz offline. Toda la PKI de la VPN es ECDSA; RSA
 * solo se acepta como clave de *dispositivo* por compatibilidad (ver
 * `signDeviceCsr` en services/deviceCerts.ts), nunca para la CA.
 */
export const EC_P384_SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-384' } as const;

/** Genera un par de claves ECDSA (P-384 por defecto) para la CA intermedia. */
export async function generateEcKeyPair(
  namedCurve: 'P-256' | 'P-384' = 'P-384',
): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

/** Exporta una clave privada en PEM (PKCS8), para cifrarla y guardarla. */
export async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, x509.PemConverter.PrivateKeyTag);
}

/** Reimporta una clave privada ECDSA (PKCS8 PEM) previamente exportada, solo para firmar. */
export async function importEcPrivateKeyPem(
  pem: string,
  namedCurve: 'P-256' | 'P-384' = 'P-384',
): Promise<CryptoKey> {
  const der = x509.PemConverter.decodeFirst(pem);
  return webcrypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve }, false, ['sign']);
}

/** SHA-256 en hexadecimal de un buffer (p.ej. la SubjectPublicKeyInfo de un certificado/CSR). */
export function sha256Hex(data: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

/**
 * `X509Crl.toString()` de @peculiar/x509 etiqueta el PEM como
 * "-----BEGIN CRL-----" (`PemConverter.CrlTag = "CRL"`, fijo en la
 * libreria), no "-----BEGIN X509 CRL-----" -la etiqueta que exige RFC 7468
 * SS4 para una CRL, y la UNICA que reconocen `openssl crl` y
 * `PEM_read_bio_X509_CRL` (verificado generando la misma CRL con las dos
 * etiquetas: solo "X509 CRL" parsea). Sin esto, cualquier consumidor basado
 * en OpenSSL (incluido FreeRADIUS) no puede leer las CRL que sirve este
 * panel. Usar SIEMPRE esta funcion en vez de `crl.toString()` para guardar o
 * servir una CRL en PEM -nunca el metodo de la libreria directamente-.
 */
export function crlToPem(crl: x509.X509Crl): string {
  return crl
    .toString()
    .replace('-----BEGIN CRL-----', '-----BEGIN X509 CRL-----')
    .replace('-----END CRL-----', '-----END X509 CRL-----');
}

/** Huella SHA-256 de la SubjectPublicKeyInfo de un certificado o CSR, en hexadecimal minusculas. */
export function spkiSha256(certOrCsr: { publicKey: x509.PublicKey }): string {
  return sha256Hex(certOrCsr.publicKey.rawData);
}

/** Serial aleatorio de 128 bits en hexadecimal minusculas, sin bit de signo ambiguo. */
export function randomSerialHex(): string {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f; // evita que el primer bit quede a 1 (se leeria como numero negativo en DER)
  return bytes.toString('hex');
}

export interface ParsedCertificate {
  serial: string;
  cn: string;
  notBefore: Date;
  notAfter: Date;
}

/** Extrae serial (hex minusculas), CN y fechas (UTC) de un certificado PEM/DER. */
export function parseCertificate(pem: string | ArrayBuffer): ParsedCertificate {
  const cert = new x509.X509Certificate(pem);
  const cn = cert.subjectName.getField('CN')[0] ?? '';
  return {
    serial: cert.serialNumber.toLowerCase(),
    cn,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
  };
}
