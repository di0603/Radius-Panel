import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { config } from '../config.js';

/**
 * Firma Ed25519 de los perfiles de aprovisionamiento (.didevvpn) de las apps
 * (Windows/Android): la clave publica va incrustada en cada app, para que
 * una app nunca acepte un perfil que no venga de este panel. La clave
 * privada la genera un admin aparte (fuera de este repo, ver README) y solo
 * se referencia por ruta en VPN_PROFILE_SIGNING_KEY -nunca en la base de
 * datos ni en el codigo-, igual que EST_TLS_KEY.
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
  return {
    payload: bytes.toString('base64url'),
    signature: signature.toString('base64url'),
    keyId: PROFILE_SIGNING_KEY_ID,
  };
}
