import assert from 'node:assert/strict';
import test from 'node:test';
import { intToIpv4, ipv4ToInt, isValidIpv4 } from './ipv4.js';

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
