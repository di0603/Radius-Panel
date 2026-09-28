import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { TRUSTED_PROXIES } from './trustProxy.js';

/**
 * `req.ip` (usado por los rate-limit por IP y por la restriccion "solo desde
 * la VPN/LAN" de la descarga Android, ver services/androidCert.ts) depende
 * de `app.set('trust proxy', ...)`. Estas pruebas fabrican un `req` minimo
 * sobre el propio prototipo de Express (`express.request`, lo que expone
 * para extenderlo) para ejercitar el getter `ip` real -el mismo que usa la
 * app en produccion- sin levantar un servidor ni una conexion TCP real.
 */

function fakeReq(app: express.Express, remoteAddress: string, xForwardedFor?: string) {
  const req = Object.create(express.request) as express.Request;
  req.app = app;
  req.headers = xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {};
  req.socket = { remoteAddress } as never;
  return req;
}

function appWithTrust(): express.Express {
  const app = express();
  app.set('trust proxy', TRUSTED_PROXIES);
  return app;
}

test('trust proxy: confia en loopback y en Nginx Proxy Manager (192.168.10.38)', () => {
  const app = appWithTrust();
  const trust = app.get('trust proxy fn') as (ip: string, i: number) => boolean;
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('::1', 0), true);
  assert.equal(trust('192.168.10.38', 0), true);
});

test('trust proxy: no confia en cualquier IP de la LAN, solo en 192.168.10.38', () => {
  const app = appWithTrust();
  const trust = app.get('trust proxy fn') as (ip: string, i: number) => boolean;
  assert.equal(trust('192.168.10.28', 0), false); // FreeRADIUS/el propio panel
  assert.equal(trust('192.168.10.29', 0), false); // la VM de la VPN
  assert.equal(trust('192.168.10.39', 0), false); // vecino de NPM, no es NPM
});

test('trust proxy: una peticion que llega directamente de una IP no confiada ignora su propio X-Forwarded-For', () => {
  const app = appWithTrust();
  // Simula un atacante que consigue conectar directamente a Node (saltandose
  // nginx/NPM, p.ej. por un fallo del firewall) e inventa una cadena de dos
  // IPs para intentar hacerse pasar por otro cliente: con "trust proxy"
  // como numero (el fallo que esto corrige), esas dos IPs falsas se habrian
  // aceptado sin comprobar nada.
  const req = fakeReq(app, '203.0.113.66', '9.9.9.9, 8.8.8.8');
  assert.equal(req.ip, '203.0.113.66', 'debe ignorar el X-Forwarded-For y usar la IP real del socket');
});

test('trust proxy: cadena real (cliente -> NPM -> nginx local) resuelve la IP real del cliente', () => {
  const app = appWithTrust();
  // nginx local reenvia por loopback (peer real = 127.0.0.1, confiado);
  // X-Forwarded-For trae lo que puso NPM: el cliente real y su propia IP
  // (192.168.10.38, tambien confiada) al final.
  const req = fakeReq(app, '127.0.0.1', '198.51.100.7, 192.168.10.38');
  assert.equal(req.ip, '198.51.100.7');
});

test('trust proxy: si NPM reenviara un X-Forwarded-For con una IP de mas (no confiada) antes de la real, esa es la que se usa', () => {
  const app = appWithTrust();
  // Cadena con una IP intermedia no confiada (ni loopback ni 192.168.10.38)
  // antes del cliente real: el recorrido se para ahi, no sigue hasta el
  // extremo izquierdo -asi se comportaria tambien si alguien intentara
  // colar una IP falsa justo despues de la suya propia-.
  const req = fakeReq(app, '127.0.0.1', '198.51.100.7, 203.0.113.66, 192.168.10.38');
  assert.equal(req.ip, '203.0.113.66');
});
