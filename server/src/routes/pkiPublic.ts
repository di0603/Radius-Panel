import { Router } from 'express';
import { asyncHandler, notFound } from '../lib/http.js';
import { getCaChainPem, getCrlBundlePem } from '../services/pki.js';

/**
 * Publicacion de la PKI de la VPN, sin autenticacion: es informacion publica
 * (igual que cualquier CA publica su cadena y su CRL). La sirve strongSwan/
 * FreeRADIUS y los dispositivos para validar el certificado del servidor y
 * comprobar revocaciones. Montado en `/pki`, fuera de `/api`.
 */
export const pkiPublicRouter = Router();

pkiPublicRouter.get(
  '/ca-chain.pem',
  asyncHandler(async (_req, res) => {
    const pem = await getCaChainPem();
    if (!pem) throw notFound('La CA de la VPN todavia no esta configurada');
    res.type('application/x-pem-file').send(pem);
  }),
);

pkiPublicRouter.get(
  '/crl.pem',
  asyncHandler(async (_req, res) => {
    const pem = await getCrlBundlePem();
    if (!pem) throw notFound('Todavia no hay ninguna CRL publicada');
    res.type('application/x-pem-file').send(pem);
  }),
);
