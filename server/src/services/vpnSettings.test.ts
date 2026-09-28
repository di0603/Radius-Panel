import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_VPN_SETTINGS, parseVpnSettingsRow, vpnSettingsSchema } from './vpnSettings.js';

test('DEFAULT_VPN_SETTINGS cumple su propio esquema de validacion', () => {
  assert.doesNotThrow(() => vpnSettingsSchema.parse(DEFAULT_VPN_SETTINGS));
});

test('parseVpnSettingsRow: sin fila, devuelve los valores por defecto', () => {
  assert.deepEqual(parseVpnSettingsRow(undefined), DEFAULT_VPN_SETTINGS);
});

test('parseVpnSettingsRow: mapea una fila snake_case de MySQL', () => {
  const row = {
    vpn_fqdn: 'vpn.example.com',
    pool_start: '192.168.10.75',
    pool_end: '192.168.10.99',
    dns: '1.1.1.1',
    device_cert_days: '30',
    renew_after_days: '20',
    overlap_hours: '48',
    android_cert_days: '365',
  };
  assert.deepEqual(parseVpnSettingsRow(row as never), {
    vpnFqdn: 'vpn.example.com',
    poolStart: '192.168.10.75',
    poolEnd: '192.168.10.99',
    dns: '1.1.1.1',
    deviceCertDays: 30,
    renewAfterDays: 20,
    overlapHours: 48,
    androidCertDays: 365,
  });
});

test('vpnSettingsSchema: rechaza renewAfterDays >= deviceCertDays', () => {
  assert.throws(() =>
    vpnSettingsSchema.parse({ ...DEFAULT_VPN_SETTINGS, deviceCertDays: 20, renewAfterDays: 20 }),
  );
});

test('vpnSettingsSchema: rechaza poolEnd anterior a poolStart', () => {
  assert.throws(() =>
    vpnSettingsSchema.parse({
      ...DEFAULT_VPN_SETTINGS,
      poolStart: '192.168.10.99',
      poolEnd: '192.168.10.75',
    }),
  );
});

test('vpnSettingsSchema: rechaza una IPv4 invalida', () => {
  assert.throws(() => vpnSettingsSchema.parse({ ...DEFAULT_VPN_SETTINGS, poolStart: '999.1.1.1' }));
  assert.throws(() =>
    vpnSettingsSchema.parse({ ...DEFAULT_VPN_SETTINGS, poolEnd: 'no-es-una-ip' }),
  );
});

test('vpnSettingsSchema: acepta poolStart igual a poolEnd (rango de un solo host)', () => {
  assert.doesNotThrow(() =>
    vpnSettingsSchema.parse({
      ...DEFAULT_VPN_SETTINGS,
      poolStart: '192.168.10.80',
      poolEnd: '192.168.10.80',
    }),
  );
});
