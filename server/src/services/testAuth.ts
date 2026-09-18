import { config } from '../config.js';
import { ApiError } from '../lib/http.js';
import { sendAccessRequest, type AccessRequestResult } from '../lib/radiusPacket.js';

/** Lanza un Access-Request PAP contra el FreeRADIUS y devuelve el resultado. */
export async function testAuthentication(
  username: string,
  password: string,
): Promise<AccessRequestResult> {
  if (!config.testAuth.enabled) {
    throw new ApiError(
      503,
      'La prueba de autenticacion esta deshabilitada (RADIUS_TEST_ENABLED=false)',
    );
  }
  try {
    return await sendAccessRequest({
      host: config.testAuth.host,
      port: config.testAuth.port,
      secret: config.testAuth.secret,
      timeoutMs: config.testAuth.timeoutMs,
      username,
      password,
    });
  } catch (err) {
    throw new ApiError(502, `No se pudo contactar con FreeRADIUS: ${(err as Error).message}`);
  }
}
