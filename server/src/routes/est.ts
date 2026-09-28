import type { TLSSocket } from 'node:tls';
import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, unauthorized } from '../lib/http.js';
import { writeAudit } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';
import { estEnrollments, estRejections, estRenewals } from '../lib/metrics.js';
import {
  EstRejection,
  certToPkcs7Base64,
  enrollDevice,
  getCaCertsPkcs7Base64,
  getStatus,
  renewDevice,
} from '../services/est.js';

/**
 * Rutas EST (RFC 7030), montadas en el listener HTTPS dedicado (ver
 * server/src/estServer.ts), no en la API principal. Sin JSON: los cuerpos
 * son PKCS10/PKCS7 en texto (base64 o PEM), como pide el RFC.
 */
export const estRouter = Router();

const PKCS7_MIME = 'application/pkcs7-mime; smime-type=certs-only';

function peerCertDer(req: Request): Buffer | null {
  const socket = req.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== 'function') return null;
  const cert = socket.getPeerCertificate(true);
  return cert && cert.raw ? cert.raw : null;
}

/** `Authorization: Basic base64(usuario:contrasena)`. El token no lleva ":", pero por si acaso solo se corta en el primero. */
function parseBasicAuth(req: Request): { username: string; password: string } | null {
  const header = req.headers.authorization ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

function clientIp(req: Request): string {
  return req.socket.remoteAddress ?? '';
}

/** No revela detalles internos (mensajes de ApiError si; nunca stack ni SQL) y audita siempre. */
async function auditAndReject(
  req: Request,
  endpoint: 'simpleenroll' | 'simplereenroll' | 'status',
  device: string,
  err: EstRejection,
): Promise<never> {
  estRejections.inc({ endpoint, reason: err.reason });
  await writeAudit(req, 'reject', `vpn_est_${endpoint}`, device || 'desconocido', {
    reason: err.reason,
    ip: clientIp(req),
  });
  logger.warn({ endpoint, device, reason: err.reason, ip: clientIp(req) }, 'EST rechazado');
  throw err.apiError;
}

/* --------------------------------- cacerts -------------------------------- */

estRouter.get(
  '/cacerts',
  asyncHandler(async (_req, res) => {
    const body = await getCaCertsPkcs7Base64();
    if (!body) {
      res.status(404).json({ error: 'La PKI de la VPN todavia no esta configurada' });
      return;
    }
    res.type(PKCS7_MIME).send(body);
  }),
);

/* ------------------------------- simpleenroll ------------------------------ */

const enrollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones de alta, prueba de nuevo en unos minutos' },
});

estRouter.post(
  '/simpleenroll',
  enrollLimiter,
  asyncHandler(async (req, res) => {
    const auth = parseBasicAuth(req);
    if (!auth) {
      res.set('WWW-Authenticate', 'Basic realm="EST"');
      throw unauthorized('Falta autenticacion HTTP Basic (usuario = dispositivo, contrasena = token)');
    }

    try {
      const result = await enrollDevice({
        username: auth.username,
        token: auth.password,
        csrBody: String(req.body ?? ''),
      });
      estEnrollments.inc({ result: 'ok' });
      await writeAudit(req, 'create', 'vpn_est_simpleenroll', auth.username, {
        serial: result.serial,
        ip: clientIp(req),
      });
      logger.info({ device: auth.username, serial: result.serial }, 'EST: alta emitida');
      res.type(PKCS7_MIME).send(certToPkcs7Base64(result.certPem));
    } catch (err) {
      estEnrollments.inc({ result: 'rejected' });
      if (err instanceof EstRejection) await auditAndReject(req, 'simpleenroll', auth.username, err);
      throw err;
    }
  }),
);

/* ------------------------------ simplereenroll ------------------------------ */

estRouter.post(
  '/simplereenroll',
  asyncHandler(async (req, res) => {
    const der = peerCertDer(req);
    let deviceForAudit = 'desconocido';
    try {
      if (!der) throw unauthorized('No se ha presentado un certificado de cliente valido');
      const result = await renewDevice({ clientCertDer: der, csrBody: String(req.body ?? '') });
      deviceForAudit = result.serial;
      estRenewals.inc({ result: 'ok' });
      await writeAudit(req, 'create', 'vpn_est_simplereenroll', result.serial, { ip: clientIp(req) });
      logger.info({ serial: result.serial }, 'EST: renovacion emitida');
      res.type(PKCS7_MIME).send(certToPkcs7Base64(result.certPem));
    } catch (err) {
      estRenewals.inc({ result: 'rejected' });
      if (err instanceof EstRejection) await auditAndReject(req, 'simplereenroll', deviceForAudit, err);
      throw err;
    }
  }),
);

/* ---------------------------------- status ---------------------------------- */

estRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const der = peerCertDer(req);
    try {
      if (!der) throw unauthorized('No se ha presentado un certificado de cliente valido');
      const status = await getStatus(der);
      res.json(status);
    } catch (err) {
      if (err instanceof EstRejection) await auditAndReject(req, 'status', 'desconocido', err);
      throw err;
    }
  }),
);
