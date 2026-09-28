import assert from 'node:assert/strict';
import test from 'node:test';
import {
  intToIpv4,
  ipv4ToInt,
  isIpv4InCidr,
  isIpv4InRange,
  isValidIpv4,
  isValidIpv4OrCidr,
} from './ipv4.js';

test('isValidIpv4: acepta IPv4 validas', () => {
  assert.equal(isValidIpv4('192.168.10.75'), true);
  assert.equal(isValidIpv4('0.0.0.0'), true);
  assert.equal(isValidIpv4('255.255.255.255'), true);
});

test('isValidIpv4: rechaza formatos invalidos', () => {
  assert.equal(isValidIpv4('256.1.1.1'), false);
  assert.equal(isValidIpv4('1.2.3'), false);
  assert.equal(isValidIpv4('1.2.3.4.5'), false);
  assert.equal(isValidIpv4('no-es-una-ip'), false);
});

test('ipv4ToInt/intToIpv4: ida y vuelta', () => {
  for (const ip of ['0.0.0.0', '192.168.10.75', '192.168.10.99', '255.255.255.255']) {
    assert.equal(intToIpv4(ipv4ToInt(ip)), ip);
  }
});

test('ipv4ToInt: orden creciente dentro de un rango', () => {
  assert.ok(ipv4ToInt('192.168.10.75') < ipv4ToInt('192.168.10.99'));
});

test('isIpv4InRange: dentro, en los bordes y fuera del rango', () => {
  assert.equal(isIpv4InRange('192.168.10.80', '192.168.10.75', '192.168.10.99'), true);
  assert.equal(isIpv4InRange('192.168.10.75', '192.168.10.75', '192.168.10.99'), true);
  assert.equal(isIpv4InRange('192.168.10.99', '192.168.10.75', '192.168.10.99'), true);
  assert.equal(isIpv4InRange('192.168.10.74', '192.168.10.75', '192.168.10.99'), false);
  assert.equal(isIpv4InRange('192.168.10.100', '192.168.10.75', '192.168.10.99'), false);
});

test('isIpv4InCidr: /24 tipico (la LAN de casa)', () => {
  assert.equal(isIpv4InCidr('192.168.10.1', '192.168.10.0/24'), true);
  assert.equal(isIpv4InCidr('192.168.10.255', '192.168.10.0/24'), true);
  assert.equal(isIpv4InCidr('192.168.11.1', '192.168.10.0/24'), false);
});

test('isIpv4InCidr: por encima de 2^31 (192.168.x.x) sin corromperse por operadores bit a bit', () => {
  // 192.168.10.0 como entero de 32 bits sin signo es 3232238080, mayor que
  // el maximo entero de 32 bits CON signo (2147483647): si el calculo usara
  // &/| de JS sin cuidado, esto podria devolver un resultado incorrecto.
  assert.ok(ipv4ToInt('192.168.10.0') > 2 ** 31);
  assert.equal(isIpv4InCidr('192.168.10.127', '192.168.10.0/25'), true);
  assert.equal(isIpv4InCidr('192.168.10.128', '192.168.10.0/25'), false); // ya es el siguiente bloque /25
  assert.equal(isIpv4InCidr('192.168.10.128', '192.168.10.128/25'), true);
});

test('isIpv4InCidr: /32 (host unico) y /0 (todo)', () => {
  assert.equal(isIpv4InCidr('192.168.10.75', '192.168.10.75/32'), true);
  assert.equal(isIpv4InCidr('192.168.10.76', '192.168.10.75/32'), false);
  assert.equal(isIpv4InCidr('1.2.3.4', '0.0.0.0/0'), true);
});

test('isIpv4InCidr: rechaza un CIDR con formato invalido', () => {
  assert.equal(isIpv4InCidr('192.168.10.1', '192.168.10.0'), false);
  assert.equal(isIpv4InCidr('192.168.10.1', '192.168.10.0/33'), false);
  assert.equal(isIpv4InCidr('192.168.10.1', 'no-es-un-cidr'), false);
});

test('isValidIpv4OrCidr: acepta una IP suelta o un CIDR', () => {
  assert.equal(isValidIpv4OrCidr('192.168.10.75'), true);
  assert.equal(isValidIpv4OrCidr('192.168.10.0/24'), true);
  assert.equal(isValidIpv4OrCidr('0.0.0.0/0'), true);
});

test('isValidIpv4OrCidr: rechaza formatos invalidos', () => {
  assert.equal(isValidIpv4OrCidr('no-es-una-ip'), false);
  assert.equal(isValidIpv4OrCidr('192.168.10.0/33'), false);
  assert.equal(isValidIpv4OrCidr('192.168.10.0/'), false);
  assert.equal(isValidIpv4OrCidr('300.1.1.1'), false);
});
