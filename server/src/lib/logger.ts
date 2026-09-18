import pino from 'pino';
import { config } from '../config.js';

/**
 * Logger estructurado. En desarrollo sale coloreado y legible; en produccion
 * sale en JSON por stdout, listo para systemd/journald o cualquier recolector.
 */
export const logger = pino({
  level: config.logLevel,
  base: undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.secret',
      '*.token',
    ],
    censor: '[oculto]',
  },
  transport: config.isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
});

export type Logger = typeof logger;
