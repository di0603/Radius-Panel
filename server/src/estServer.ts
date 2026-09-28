import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerOptions } from 'node:https';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ApiError } from './lib/http.js';
import { logger } from './lib/logger.js';
import { getCaChainPem } from './services/pki.js';
import { estRouter } from './routes/est.js';

/**
 * Listener HTTPS dedicado para EST (RFC 7030), separado de la API principal
 * (server/src/index.ts): necesita TLS mutuo (`requestCert`) para que el
 * dispositivo pueda presentar su certificado en `simplereenroll`, algo que
 * un proxy TLS-terminating como nginx no deja pasar sin reenviarlo aparte.
 * Certificado de servidor propio (EST_TLS_CERT/KEY), firmado por la raiz
 * offline para el nombre publico de la PKI (no por Let's Encrypt): los
 * dispositivos validan esta conexion solo contra esa raiz, no contra el
 * almacen de confianza general del sistema.
 */

/** Solo ECDHE + AEAD (GCM/ChaCha20), TLS 1.2 como minimo. TLS 1.3 ya es AEAD siempre. */
export const EST_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');

/** No revela detalles internos (RFC 7030 no exige JSON de error; nunca stack ni SQL). */
function estErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Peticion invalida' });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ err, path: req.path }, '[est] error interno');
  res.status(500).json({ error: 'Error interno' });
}

/** La app Express de EST, sin nada de red: separado para poder probarlo sin abrir un puerto real. */
export function createEstApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // CSR en application/pkcs10 (base64 DER, RFC 7030) o PEM "por comodidad":
  // en los dos casos llega como texto plano, nunca JSON.
  app.use(
    express.text({ type: ['application/pkcs10', 'application/pkcs7-mime', 'text/plain'], limit: '64kb' }),
  );
  app.use('/.well-known/est', estRouter);
  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  app.use(estErrorHandler);
  return app;
}

export interface EstServerOverrides {
  cert?: Buffer | string;
  key?: Buffer | string;
  ca?: Buffer | string;
  port?: number;
  bind?: string;
}

/**
 * Arranca el listener HTTPS de EST. `overrides` es solo para los tests (les
 * permite pasar certificados generados en memoria y un puerto efimero, en
 * vez de depender de EST_TLS_CERT/EST_TLS_KEY en disco); en produccion se
 * usa siempre la configuracion de server/.env.
 */
export async function startEstServer(overrides: EstServerOverrides = {}): Promise<Server | null> {
  if (!overrides.cert && !config.est.enabled) {
    logger.info(
      'EST deshabilitado (falta EST_TLS_CERT/EST_TLS_KEY o EST_ENABLED=false): sin alta/renovacion automatica de dispositivos.',
    );
    return null;
  }

  const cert = overrides.cert ?? readFileSync(config.est.tlsCert!);
  const key = overrides.key ?? readFileSync(config.est.tlsKey!);
  const ca = overrides.ca ?? ((await getCaChainPem()) ?? undefined);
  if (!ca) {
    logger.warn(
      'EST arranca sin ninguna CA de la VPN configurada todavia: simpleenroll/simplereenroll fallaran hasta que haya una CA intermedia activa.',
    );
  }

  const tlsOptions: ServerOptions = {
    cert,
    key,
    ca,
    requestCert: true,
    // El alta inicial (simpleenroll) llega sin certificado de cliente: la
    // validacion de "quien puede renovar" la hacemos nosotros a mano en
    // services/est.ts, no la deja Node a cargo del handshake TLS.
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    ciphers: EST_CIPHERS,
    honorCipherOrder: true,
  };

  const server = createServer(tlsOptions, createEstApp());

  const port = overrides.port ?? config.est.port;
  const bind = overrides.bind ?? config.est.bind;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.info(`EST escuchando en https://${bind}:${port}/.well-known/est/`);
  return server;
}
