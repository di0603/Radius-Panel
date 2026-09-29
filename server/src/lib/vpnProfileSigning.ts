import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { config } from '../config.js';

/**
 * Firma Ed25519 de los perfiles de aprovisionamiento (.didevvpn) de las apps.
 * Desde el prompt 12.5, las apps son clientes GENERICOS (como FortiClient):
 * se compilan sin ninguna clave de didev incrustada, asi que ya no basta con
 * que la app "ya conozca" la clave publica del panel. En su lugar, cada
 * sobre firmado lleva la clave publica del panel (`signerPublicKey`, SPKI
 * DER) y el payload firmado lleva su huella (`signerKeySha256`, ver
 * services/vpnProvisioning.ts): la app aprende la clave la PRIMERA vez que
 * ve un servidor (confianza en el primer uso, TOFU) y a partir de ahi exige
 * que coincida exactamente, avisando si cambia. La clave privada la genera
 * un admin aparte (fuera de este repo, ver README) y solo se referencia por
 * ruta en VPN_PROFILE_SIGNING_KEY -nunca en la base de datos ni en el
 * codigo-, igual que EST_TLS_KEY.
 */

/** Identificador de la clave activa: para poder rotarla en el futuro sin romper apps ya provisionadas. */
export const PROFILE_SIGNING_KEY_ID = 'vpn-profile-signing-v1';

export function isProfileSigningConfigured(): boolean {
  return !!config.vpnProfileSigning.keyPath;
}

/**
 * Carga la clave de firma desde disco cada vez (sin cachear en memoria): no
 * es una operacion frecuente -solo al generar un token de alta-, y evitar el
 * cache hace que sea trivial de probar (los tests solo tienen que cambiar
 * `config.vpnProfileSigning.keyPath`) y que rotar el fichero en caliente
 * surta efecto sin reiniciar el proceso.
 */
function loadSigningKey() {
  const keyPath = config.vpnProfileSigning.keyPath;
  if (!keyPath) {
    throw new Error(
      'Falta VPN_PROFILE_SIGNING_KEY en server/.env: no se puede firmar el perfil de aprovisionamiento.',
    );
  }
  const pem = readFileSync(keyPath, 'utf8');
  return createPrivateKey({ key: pem, format: 'pem' });
}

export interface SignedProfileEnvelope {
  /** Base64url de los bytes UTF-8 exactos del JSON firmado (nunca se re-serializa para verificar). */
  payload: string;
  /** Base64url de la firma Ed25519 sobre esos mismos bytes. */
  signature: string;
  keyId: string;
  /**
   * Clave publica Ed25519 del panel, SPKI DER en base64url. La app la
   * aprende de aqui -ya no viene incrustada en el binario- y verifica la
   * firma con ella; el payload firmado lleva su huella
   * (`signerKeySha256`), asi que esta clave no se puede sustituir sin
   * invalidar la firma. Fuera del payload firmado a proposito: es
   * informacion publica sobre QUIEN firmo, no parte de lo firmado.
   */
  signerPublicKey: string;
}

/** SPKI DER (formato binario, sin envoltorio PEM) de la clave publica Ed25519 de firma, en base64url. */
export function getSignerPublicKeySpkiBase64Url(): string {
  const key = loadSigningKey();
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return der.toString('base64url');
}

/** SHA-256 (hex, minusculas) del SPKI DER de la clave publica de firma: la "huella del panel" que se compara a ojo con la app. */
export function getSignerPublicKeySha256Hex(): string {
  const key = loadSigningKey();
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Firma un objeto como perfil de aprovisionamiento. El "payload" del sobre
 * es opaco (base64 de los bytes tal cual), no el JSON reformateado: asi
 * quien verifique no tiene que reproducir bit a bit el mismo formateo de
 * JSON.stringify para que la firma cuadre, solo decodificar el base64 y
 * comprobar la firma contra esos bytes literales.
 */
export function signProfilePayload(payloadObj: unknown): SignedProfileEnvelope {
  const key = loadSigningKey();
  const bytes = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  // `sign(null, ...)` es la forma que exige node:crypto para EdDSA (Ed25519):
  // el algoritmo de hash va implicito en la propia curva, no se especifica aparte.
  const signature = sign(null, bytes, key);
  const signerPublicKeyDer = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return {
    payload: bytes.toString('base64url'),
    signature: signature.toString('base64url'),
    keyId: PROFILE_SIGNING_KEY_ID,
    signerPublicKey: signerPublicKeyDer.toString('base64url'),
  };
}
