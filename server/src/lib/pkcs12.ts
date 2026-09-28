import { webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { x509 } from './x509.js';

/**
 * pkijs (igual que @peculiar/x509) necesita un motor WebCrypto explicito
 * antes de usar cualquier clase que firme/cifre; Node ya trae uno integrado.
 */
pkijs.setEngine(
  'NodeJS',
  new pkijs.CryptoEngine({ name: 'NodeJS', crypto: webcrypto as unknown as Crypto }),
);

/**
 * Construye un PKCS#12 (.p12) con el certificado y la clave privada de un
 * dispositivo Android: la app de strongSwan para Android no sabe renovarse
 * sola por EST (a diferencia de Windows/Linux), asi que para ese caso el
 * panel genera la clave y entrega un .p12 cifrado una unica vez -excepcion
 * documentada en el CHANGELOG-.
 *
 * Estructura equivalente a la que genera `openssl pkcs12 -export`: la clave
 * va en un PKCS8ShroudedKeyBag cifrado con la contrasena, y el certificado
 * en un SafeContents cifrado aparte con la misma contrasena (en vez de sin
 * cifrar, como en el PKCS12 "minimo" de los ejemplos de pkijs); las dos
 * bolsas comparten un localKeyId para que el importador (incluido el de
 * Android) sepa emparejar la clave con su certificado. AES-256-CBC/SHA-256
 * en vez de los 3DES/RC2/SHA-1 historicos de PKCS12, a juego con el resto
 * de la PKI de este proyecto.
 */
export async function buildPkcs12(
  certPem: string,
  privateKeyPkcs8Pem: string,
  password: string,
): Promise<Buffer> {
  const certDer = x509.PemConverter.decodeFirst(certPem);
  const keyDer = x509.PemConverter.decodeFirst(privateKeyPkcs8Pem);

  const cert = pkijs.Certificate.fromBER(certDer);
  const pkcs8 = pkijs.PrivateKeyInfo.fromBER(keyDer);

  const localKeyId = webcrypto.getRandomValues(new Uint8Array(16)).buffer;
  const passwordBuffer = new TextEncoder().encode(password).buffer as ArrayBuffer;
  // El tipo de pkijs para `contentEncryptionAlgorithm` exige `iv` (la forma
  // que necesita SubtleCrypto.encrypt), pero aqui solo hace falta escoger el
  // algoritmo/longitud: el IV lo genera pkijs internamente por cada PBES2
  // (visto en su codigo fuente, EncryptedData.encryptEncryptedContentInfo),
  // nunca lee este campo.
  const aes256cbc = { name: 'AES-CBC', length: 256 } as unknown as pkijs.ContentEncryptionAlgorithm;

  const keyBag = new pkijs.SafeBag({
    bagId: '1.2.840.113549.1.12.10.1.2', // pkcs-8ShroudedKeyBag
    bagValue: new pkijs.PKCS8ShroudedKeyBag({ parsedValue: pkcs8 }),
    bagAttributes: [
      new pkijs.Attribute({
        type: '1.2.840.113549.1.9.21', // localKeyID
        values: [new asn1js.OctetString({ valueHex: localKeyId })],
      }),
    ],
  });
  await keyBag.bagValue.makeInternalValues({
    password: passwordBuffer,
    contentEncryptionAlgorithm: aes256cbc,
    hmacHashAlgorithm: 'SHA-256',
    iterationCount: 100_000,
  });

  const certBag = new pkijs.SafeBag({
    bagId: '1.2.840.113549.1.12.10.1.3', // certBag
    bagValue: new pkijs.CertBag({ parsedValue: cert }),
    bagAttributes: [
      new pkijs.Attribute({
        type: '1.2.840.113549.1.9.21', // localKeyID, igual que en keyBag: asi el importador los empareja
        values: [new asn1js.OctetString({ valueHex: localKeyId })],
      }),
    ],
  });

  const authenticatedSafe = new pkijs.AuthenticatedSafe({
    parsedValue: {
      safeContents: [
        { privacyMode: 0, value: new pkijs.SafeContents({ safeBags: [keyBag] }) },
        { privacyMode: 1, value: new pkijs.SafeContents({ safeBags: [certBag] }) },
      ],
    },
  });

  const pfx = new pkijs.PFX({
    parsedValue: {
      integrityMode: 0, // integridad por contrasena (HMAC), no por certificado
      authenticatedSafe,
    },
  });

  await authenticatedSafe.makeInternalValues({
    safeContents: [
      {}, // el keyBag ya va cifrado el mismo (PKCS8ShroudedKeyBag); este SafeContents no se cifra otra vez
      {
        password: passwordBuffer,
        contentEncryptionAlgorithm: aes256cbc,
        hmacHashAlgorithm: 'SHA-256',
        iterationCount: 100_000,
      },
    ],
  });

  await pfx.makeInternalValues({
    password: passwordBuffer,
    iterations: 100_000,
    pbkdf2HashAlgorithm: 'SHA-256',
    hmacHashAlgorithm: 'SHA-256',
  });

  return Buffer.from(pfx.toSchema().toBER(false));
}
