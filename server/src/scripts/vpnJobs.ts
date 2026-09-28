/**
 * Mantenimiento periodico del modulo VPN: certificados superseded cuya
 * ventana de solapamiento ya paso (-> revoked + CRL), poda de certificados
 * caducados fuera de la CRL, tokens de alta EST caducados y regeneracion de
 * la CRL si le queda poco. Idempotente y seguro si dos ejecuciones se
 * solapan (bloqueo GET_LOCK de MySQL: la segunda se omite sin hacer nada).
 *
 *   npm run vpn:jobs
 *
 * En produccion lo dispara deploy/radius-panel-vpn-jobs.timer cada 15 min.
 */
import 'dotenv/config';
import { closePools } from '../db/pools.js';
import { logger } from '../lib/logger.js';
import { runVpnJobs } from '../services/vpnJobs.js';

async function main(): Promise<void> {
  const summary = await runVpnJobs();
  if (!summary) {
    logger.info('vpn:jobs: omitido (ya habia otra ejecucion en marcha)');
  } else {
    logger.info(summary, 'vpn:jobs: completado');
  }
  await closePools();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'vpn:jobs: fallo');
  process.exitCode = 1;
});
