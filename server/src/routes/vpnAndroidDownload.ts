import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { writeAudit } from '../middleware/audit.js';
import { consumeAndroidDownload } from '../services/androidCert.js';

/**
 * Descarga del .p12/.sswan de un dispositivo Android: deliberadamente sin
 * `requireAuth` (a diferencia de `vpnDevicesRouter`). El enlace lo genera un
 * admin desde "Emitir certificado", pero quien lo abre puede ser el propio
 * telefono del usuario final, que no tiene por que tener sesion en el
 * panel -de ahi que la seguridad la den el token de un solo uso (256 bits),
 * la caducidad de 15 minutos y la restriccion por IP (VPN o LAN), no una
 * sesion de admin. Montado fuera de vpnDevicesRouter para no heredar su
 * `requireAuth`/`requireRole('admin')`.
 */
export const vpnAndroidDownloadRouter = Router();

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, prueba de nuevo en unos minutos' },
});

const querySchema = z.object({ token: z.string().min(1) });

vpnAndroidDownloadRouter.get(
  '/:username/download',
  downloadLimiter,
  asyncHandler(async (req, res) => {
    const { token } = querySchema.parse(req.query);
    const ip = req.ip ?? '';
    try {
      const result = await consumeAndroidDownload(req.params.username, token, ip);
      await writeAudit(req, 'create', 'vpn_android_download', req.params.username, { ip });
      res.type('application/vnd.strongswan.profile').attachment(result.filename).send(result.sswanJson);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'error desconocido';
      await writeAudit(req, 'reject', 'vpn_android_download', req.params.username, { ip, reason });
      throw err;
    }
  }),
);
