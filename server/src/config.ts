import 'dotenv/config';
import { z } from 'zod';

/**
 * Configuracion del servidor validada con zod: si falta algo o tiene un valor
 * imposible, el proceso muere al arrancar con un mensaje claro en vez de
 * fallar a mitad de una peticion.
 */

const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: port.default(4000),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET debe tener al menos 16 caracteres'),
  /** Vida del access token. Corta a proposito: se renueva con el refresh token. */
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: positiveInt.default(7),
  /** `true` obliga a cookies Secure (solo HTTPS). Por defecto, activo en produccion. */
  COOKIE_SECURE: z.enum(['true', 'false', 'auto']).default('auto'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  LOGIN_MAX_ATTEMPTS: positiveInt.default(5),
  LOGIN_LOCK_MINUTES: positiveInt.default(15),
  LOGIN_WINDOW_MINUTES: positiveInt.default(15),
  TOTP_ISSUER: z.string().min(1).default('Radius Panel'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  METRICS_ENABLED: bool('true'),

  RADIUS_DB_HOST: z.string().default('127.0.0.1'),
  RADIUS_DB_PORT: port.default(3306),
  RADIUS_DB_USER: z.string().min(1, 'Falta RADIUS_DB_USER (revisa server/.env)'),
  RADIUS_DB_PASSWORD: z.string().default(''),
  RADIUS_DB_NAME: z.string().default('radius'),

  PANEL_DB_HOST: z.string().default('127.0.0.1'),
  PANEL_DB_PORT: port.default(3306),
  PANEL_DB_USER: z.string().min(1, 'Falta PANEL_DB_USER (revisa server/.env)'),
  PANEL_DB_PASSWORD: z.string().default(''),
  PANEL_DB_NAME: z.string().default('radius_panel'),
  DB_POOL_SIZE: positiveInt.default(10),

  COA_ENABLED: bool('true'),
  COA_PORT: port.default(3799),
  COA_TIMEOUT_MS: positiveInt.default(3000),

  RADIUS_TEST_ENABLED: bool('true'),
  RADIUS_AUTH_HOST: z.string().default('127.0.0.1'),
  RADIUS_AUTH_PORT: port.default(1812),
  RADIUS_AUTH_SECRET: z.string().default('testing123'),
  RADIUS_AUTH_TIMEOUT_MS: positiveInt.default(3000),

  /**
   * Login con Google, opcional: sin GOOGLE_CLIENT_ID el boton no se ofrece.
   * GOOGLE_ENABLED permite apagarlo sin borrar las credenciales (por ejemplo,
   * para probarlo rapido sin tener que quitar y volver a poner el client id).
   */
  GOOGLE_ENABLED: bool('true'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Configuracion invalida en server/.env:\n${problems}`);
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

export const config = {
  env: env.NODE_ENV,
  isProd,
  port: env.PORT,
  corsOrigin: env.CORS_ORIGIN,
  logLevel: env.LOG_LEVEL,
  metricsEnabled: env.METRICS_ENABLED,

  jwtSecret: env.JWT_SECRET,
  accessTokenTtl: env.ACCESS_TOKEN_TTL,
  refreshTokenDays: env.REFRESH_TOKEN_DAYS,
  cookieSecure: env.COOKIE_SECURE === 'auto' ? isProd : env.COOKIE_SECURE === 'true',
  cookieSameSite: env.COOKIE_SAMESITE,

  login: {
    maxAttempts: env.LOGIN_MAX_ATTEMPTS,
    lockMinutes: env.LOGIN_LOCK_MINUTES,
    windowMinutes: env.LOGIN_WINDOW_MINUTES,
  },
  totpIssuer: env.TOTP_ISSUER,

  radiusDb: {
    host: env.RADIUS_DB_HOST,
    port: env.RADIUS_DB_PORT,
    user: env.RADIUS_DB_USER,
    password: env.RADIUS_DB_PASSWORD,
    database: env.RADIUS_DB_NAME,
  },

  panelDb: {
    host: env.PANEL_DB_HOST,
    port: env.PANEL_DB_PORT,
    user: env.PANEL_DB_USER,
    password: env.PANEL_DB_PASSWORD,
    database: env.PANEL_DB_NAME,
  },
  dbPoolSize: env.DB_POOL_SIZE,

  coa: {
    enabled: env.COA_ENABLED,
    port: env.COA_PORT,
    timeoutMs: env.COA_TIMEOUT_MS,
  },

  testAuth: {
    enabled: env.RADIUS_TEST_ENABLED,
    host: env.RADIUS_AUTH_HOST,
    port: env.RADIUS_AUTH_PORT,
    secret: env.RADIUS_AUTH_SECRET,
    timeoutMs: env.RADIUS_AUTH_TIMEOUT_MS,
  },

  google: {
    enabled: env.GOOGLE_ENABLED && !!env.GOOGLE_CLIENT_ID,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  },
};

export type AppConfig = typeof config;
