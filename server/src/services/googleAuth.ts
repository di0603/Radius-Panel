import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

const client = config.google.clientId ? new OAuth2Client(config.google.clientId) : null;

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/**
 * Verifica un ID token emitido por Google Identity Services (el `credential`
 * que devuelve el boton de "Iniciar sesion con Google" en el navegador).
 * Comprueba firma, expiracion y audiencia contra nuestro GOOGLE_CLIENT_ID.
 */
export async function verifyGoogleCredential(idToken: string): Promise<GoogleProfile> {
  if (!client) throw new Error('Login con Google no configurado (falta GOOGLE_CLIENT_ID)');

  const ticket = await client.verifyIdToken({ idToken, audience: config.google.clientId! });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error('Token de Google invalido');

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
  };
}
