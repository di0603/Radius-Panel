import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { assertDbConnectivity, closePools, radiusPool, panelPool } from './db/pools.js';
import { APP_VERSION } from './version.js';

const app = express();

app.set('trust proxy', 1);
app.use((req, res, next) => {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
});
app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: false }));
app.use(express.json({ limit: '512kb' }));
morgan.token('id', (req) => (req as express.Request).id);
app.use(morgan(':id :method :url :status :response-time ms'));

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
app.use('/api', apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

async function main(): Promise<void> {
  try {
    await assertDbConnectivity();
    console.log('[db] conexion con MySQL verificada');
  } catch (err) {
    console.error('[db] no se pudo conectar con MySQL:', (err as Error).message);
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`[api] escuchando en http://localhost:${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[api] ${signal} recibido, cerrando...`);
    server.close();
    await closePools();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
