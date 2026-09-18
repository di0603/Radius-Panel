import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name} (revisa server/.env)`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(optional('PORT', '4000')),
  corsOrigin: optional('CORS_ORIGIN', 'http://localhost:5173'),

  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '8h'),

  radiusDb: {
    host: optional('RADIUS_DB_HOST', '127.0.0.1'),
    port: Number(optional('RADIUS_DB_PORT', '3306')),
    user: required('RADIUS_DB_USER'),
    password: optional('RADIUS_DB_PASSWORD', ''),
    database: optional('RADIUS_DB_NAME', 'radius'),
  },

  panelDb: {
    host: optional('PANEL_DB_HOST', '127.0.0.1'),
    port: Number(optional('PANEL_DB_PORT', '3306')),
    user: required('PANEL_DB_USER'),
    password: optional('PANEL_DB_PASSWORD', ''),
    database: optional('PANEL_DB_NAME', 'radius_panel'),
  },

  coa: {
    enabled: optional('COA_ENABLED', 'true') === 'true',
    port: Number(optional('COA_PORT', '3799')),
    timeoutMs: Number(optional('COA_TIMEOUT_MS', '3000')),
  },

  testAuth: {
    enabled: optional('RADIUS_TEST_ENABLED', 'true') === 'true',
    host: optional('RADIUS_AUTH_HOST', '127.0.0.1'),
    port: Number(optional('RADIUS_AUTH_PORT', '1812')),
    secret: optional('RADIUS_AUTH_SECRET', 'testing123'),
    timeoutMs: Number(optional('RADIUS_AUTH_TIMEOUT_MS', '3000')),
  },
};

export type AppConfig = typeof config;
