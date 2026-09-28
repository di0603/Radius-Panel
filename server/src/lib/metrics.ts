import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export const registry = new Registry();

if (config.metricsEnabled) {
  collectDefaultMetrics({ register: registry, prefix: 'radius_panel_' });
}

const httpDuration = new Histogram({
  name: 'radius_panel_http_request_duration_seconds',
  help: 'Duracion de las peticiones HTTP',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

const httpTotal = new Counter({
  name: 'radius_panel_http_requests_total',
  help: 'Peticiones HTTP atendidas',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const loginAttempts = new Counter({
  name: 'radius_panel_login_attempts_total',
  help: 'Intentos de acceso al panel',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const coaRequests = new Counter({
  name: 'radius_panel_coa_requests_total',
  help: 'Paquetes CoA/Disconnect enviados a los NAS',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const estEnrollments = new Counter({
  name: 'radius_panel_est_enrollments_total',
  help: 'Altas EST (simpleenroll) atendidas',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const estRenewals = new Counter({
  name: 'radius_panel_est_renewals_total',
  help: 'Renovaciones EST (simplereenroll) atendidas',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const estRejections = new Counter({
  name: 'radius_panel_est_rejections_total',
  help: 'Peticiones EST rechazadas, por endpoint y motivo',
  labelNames: ['endpoint', 'reason'] as const,
  registers: [registry],
});

/**
 * Gauges de alertas del modulo VPN (services/vpnAlerts.ts actualiza los
 * valores; aqui solo se declaran, igual que el resto de metricas). Se
 * refrescan en cada scrape de /metrics, no con un timer propio.
 */
export const vpnRenewalFailingGauge = new Gauge({
  name: 'radius_panel_vpn_renewal_failing_devices',
  help: 'Dispositivos Windows/Linux cuya renovacion automatica por EST deberia haber saltado y no lo ha hecho',
  labelNames: ['severity'] as const,
  registers: [registry],
});

export const vpnAndroidExpiringGauge = new Gauge({
  name: 'radius_panel_vpn_android_expiring_soon',
  help: 'Dispositivos Android cuyo certificado caduca dentro de la ventana de aviso',
  registers: [registry],
});

export const vpnCaExpiringGauge = new Gauge({
  name: 'radius_panel_vpn_ca_expiring_soon',
  help: 'CAs intermedias de la VPN que caducan dentro de la ventana de aviso',
  registers: [registry],
});

export const vpnEstRejectionsLastHourGauge = new Gauge({
  name: 'radius_panel_vpn_est_rejections_last_hour',
  help: 'Peticiones EST rechazadas en la ultima hora (segun panel_audit_log)',
  registers: [registry],
});

/**
 * Mide cada peticion. Usa la ruta de Express (`/api/users/:username`) en vez de
 * la URL real para no crear una serie temporal por cada usuario.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.metricsEnabled) return next();
  const done = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : (req.baseUrl ?? req.path ?? 'desconocida');
    const labels = { method: req.method, route, status: String(res.statusCode) };
    done(labels);
    httpTotal.inc(labels);
  });
  next();
}
