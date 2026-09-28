import { badRequest } from '../lib/http.js';
import { EC_P384_SIGNING_ALGORITHM, randomSerialHex, sha256Hex, x509 } from '../lib/x509.js';

/**
 * Emision de certificados de dispositivo firmados por la CA intermedia.
 * Pura respecto a la base de datos: recibe el certificado y la clave de
 * firma de la intermedia ya cargados (ver services/pki.ts para eso), asi se
 * puede probar sin depender de MySQL ni de PKI_MASTER_KEY.
 */

export interface SignDeviceCsrInput {
  /** CSR en PEM tal como lo manda el dispositivo. Sus extensiones/atributos se ignoran. */
  csrPem: string;
  /** CN esperado (el username del dispositivo): debe coincidir exactamente con el del CSR. */
  cn: string;
  /** Dias de vigencia desde notBefore. */
  days: number;
  /** Certificado de la CA intermedia que firma (para el emisor y el AuthorityKeyIdentifier). */
  issuerCert: x509.X509Certificate;
  /** Clave privada de esa misma CA intermedia. */
  signingKey: CryptoKey;
}

export interface SignedDeviceCert {
  certPem: string;
  serial: string;
  spkiSha256: string;
  notBefore: Date;
  notAfter: Date;
}

function isAcceptableDeviceKey(
  algorithm: unknown,
): algorithm is { name: string; namedCurve?: string; modulusLength?: number } {
  const alg = algorithm as { name?: string; namedCurve?: string; modulusLength?: number };
  if (alg.name === 'ECDSA') return alg.namedCurve === 'P-256' || alg.namedCurve === 'P-384';
  if (alg.name === 'RSASSA-PKCS1-v1_5') return (alg.modulusLength ?? 0) >= 3072;
  return false;
}

/**
 * Firma el CSR de un dispositivo. Ignora cualquier extension que pida el CSR
 * (BasicConstraints, KeyUsage, SAN...): el certificado emitido lleva siempre
 * el mismo perfil fijo (KeyUsage digitalSignature, EKU clientAuth, SAN
 * dNSName = CN, AKI/SKI), sin importar lo que el dispositivo haya solicitado.
 *
 * notBefore se pone 5 minutos antes de "ahora" para tolerar un reloj de
 * dispositivo ligeramente adelantado; todas las fechas son UTC.
 */
export async function signDeviceCsr(input: SignDeviceCsrInput): Promise<SignedDeviceCert> {
  const { csrPem, cn, days, issuerCert, signingKey } = input;

  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    throw badRequest('No se ha podido leer el CSR (PEM invalido)');
  }

  if (!(await csr.verify())) {
    throw badRequest('La firma del CSR no es valida');
  }

  const csrCn = csr.subjectName.getField('CN')[0] ?? '';
  if (csrCn !== cn) {
    throw badRequest(`El CN del CSR ("${csrCn}") no coincide con el esperado ("${cn}")`);
  }

  if (!isAcceptableDeviceKey(csr.publicKey.algorithm)) {
    throw badRequest('La clave del CSR debe ser ECDSA P-256/P-384 o RSA >= 3072');
  }

  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000);
  const serial = randomSerialHex();

  const [authorityKeyId, subjectKeyId] = await Promise.all([
    x509.AuthorityKeyIdentifierExtension.create(issuerCert.publicKey),
    x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
  ]);

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial,
    // Solo el CN ya validado, nunca el subject completo del CSR: un CSR
    // puede pedir RDNs adicionales (O, OU...) ademas del CN, y el unico dato
    // de identidad que debe llevar el certificado es el que ya se ha
    // comprobado (CN == username esperado).
    subject: `CN=${cn}`,
    issuer: issuerCert.subject,
    notBefore,
    notAfter,
    publicKey: csr.publicKey,
    signingKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
      // No critica (RFC 5280 4.2.1.6): el subject ya lleva un CN no vacio.
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: cn }], false),
      authorityKeyId,
      subjectKeyId,
    ],
  });

  return {
    certPem: cert.toString(),
    serial: cert.serialNumber.toLowerCase(),
    spkiSha256: sha256Hex(cert.publicKey.rawData),
    notBefore,
    notAfter,
  };
}
