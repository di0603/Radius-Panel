import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import {
  assertDbConnectivity,
  assertPanelSchema,
  closePools,
  radiusPool,
  panelPool,
} from './db/pools.js';
import { logger } from './lib/logger.js';
import { metricsMiddleware, registry } from './lib/metrics.js';
import { purgeOldTokens } from './services/auth.js';
import { APP_VERSION } from './version.js';

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'"],
        // Mantine inyecta variables de tema en un <style>; los QR del 2FA son data:.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
  }),
);

// `credentials: true` es obligatorio: el refresh token viaja en cookie HttpOnly.
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '512kb' }));
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req as express.Request).id ?? randomUUID(),
    autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);
app.use(metricsMiddleware);

app.get('/health', async (_req, res) => {
  const checks: Record<string, boolean> = {};
  try {
    await radiusPool.query('SELECT 1');
    checks.radius = true;
  } catch {
    checks.radius = false;
  }
  try {
    await panelPool.query('SELECT 1');
    checks.panel = true;
  } catch {
    checks.panel = false;
  }
  const ok = checks.radius && checks.panel;
  res.status(ok ? 200 : 503).json({ ok, version: APP_VERSION, checks });
});

if (config.metricsEnabled) {
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });
}

app.use('/api', apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

async function main(): Promise<void> {
  try {
    await assertDbConnectivity();
    logger.info('conexion con MySQL verificada');
    await assertPanelSchema();
  } catch (err) {
    logger.fatal((err as Error).message);
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    logger.info(`API escuchando en http://localhost:${config.port}`);
  });

  // Limpieza diaria de refresh tokens caducados.
  const purgeTimer = setInterval(
    () => {
      purgeOldTokens()
        .then((n) => n && logger.info({ removed: n }, 'refresh tokens antiguos eliminados'))
        .catch((err) => logger.warn({ err }, 'no se pudieron limpiar los refresh tokens'));
    },
    24 * 60 * 60 * 1000,
  );
  purgeTimer.unref();

  const shutdown = async (signal: string) => {
    logger.info(`${signal} recibido, cerrando...`);
    clearInterval(purgeTimer);
    server.close();
    await closePools();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
