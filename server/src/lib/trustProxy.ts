/**
 * Lista explicita de proxies de confianza para `app.set('trust proxy', ...)`
 * en server/src/index.ts (ver el comentario alli para el porque de una lista
 * y no un numero de saltos): loopback (health checks/herramientas locales) y
 * Nginx Proxy Manager en 192.168.10.38, el unico salto real por delante del
 * nginx local de deploy/nginx-radius-panel.conf.
 */
export const TRUSTED_PROXIES = ['loopback', '192.168.10.38'];
