import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import {
  vpnAndroidExpiringGauge,
  vpnCaExpiringGauge,
  vpnEstRejectionsLastHourGauge,
  vpnRenewalFailingGauge,
} from '../lib/metrics.js';
import { getVpnAlerts } from './vpnAlerts.js';

/**
 * `getVpnAlerts` alimenta a la vez la tarjeta "VPN" del panel y los Gauges
 * de /metrics: cada prueba comprueba el JSON devuelto Y que los Gauges
 * quedan con el mismo numero, para no depender de que solo uno de los dos
 * consumidores funcione.
 */

const DAY = 24 * 60 * 60 * 1000;

function toSqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

interface Fixture {
  devices: { username: string; platform: string; renew_after_days: number | null; enabled: number }[];
  certs: { username: string; status: string; not_before: string; not_after: string }[];
  caRows: { id: number; subject: string | null; not_after: string; status: string }[];
  estRejectionsLastHour: number;
  settings: { renew_after_days: number };
}

function setUpMockDb(fx: Fixture) {
  mock.method(pools.panelPool, 'query', (async (sql: string) => {
    if (sql.includes('FROM panel_vpn_devices')) {
      return [fx.devices.filter((d) => d.enabled), []];
    }
    if (sql.includes('FROM panel_vpn_settings')) {
      return [
        [
          {
            vpn_fqdn: 'vpn.example.com',
            aaa_id: 'CN=radius.example.com',
            pool_start: '192.168.10.75',
            pool_end: '192.168.10.99',
            lan_cidr: '192.168.10.0/24',
            dns: '',
            device_cert_days: 30,
            renew_after_days: fx.settings.renew_after_days,
            overlap_hours: 48,
            android_cert_days: 365,
            est_url: 'https://est.example.com:8443',
          },
        ],
        [],
      ];
    }
    if (sql.includes('FROM panel_pki_ca')) {
      const now = Date.now();
      const rows = fx.caRows.filter(
        (c) =>
          (c.status === 'active' || c.status === 'retiring') &&
          Date.parse(`${c.not_after.replace(' ', 'T')}Z`) < now + 90 * DAY,
      );
      return [rows, []];
    }
    if (sql.includes('FROM panel_audit_log')) {
      return [[{ n: fx.estRejectionsLastHour }], []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  mock.method(pools.radiusPool, 'query', (async (sql: string, params?: unknown) => {
    if (sql.includes('FROM vpn_certificates WHERE status')) {
      const [usernames] = params as [string[]];
      return [fx.certs.filter((c) => usernames.includes(c.username)), []];
    }
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);
}

const BASE_SETTINGS = { renew_after_days: 20 };

test('getVpnAlerts: dispositivo windows/linux sin certificado activo -> alerta critica', async (t) => {
  setUpMockDb({
    devices: [{ username: 'vpn-juan-laptop', platform: 'windows', renew_after_days: null, enabled: 1 }],
    certs: [],
    caRows: [],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.deepEqual(alerts.renewalFailing, [
    { username: 'vpn-juan-laptop', platform: 'windows', notAfter: null, critical: true },
  ]);

  const gauge = await vpnRenewalFailingGauge.get();
  const critical = gauge.values.find((v) => v.labels.severity === 'critical')?.value;
  assert.equal(critical, 1);
});

test('getVpnAlerts: certificado activo pero ya toca renovar (no critico si le quedan dias)', async (t) => {
  const notBefore = new Date(Date.now() - 25 * DAY); // renewAfterDays=20 -> ya toca
  const notAfter = new Date(Date.now() + 5 * DAY); // le quedan 5 dias, > 3 dias criticos
  setUpMockDb({
    devices: [{ username: 'vpn-juan-laptop', platform: 'linux', renew_after_days: null, enabled: 1 }],
    certs: [
      {
        username: 'vpn-juan-laptop',
        status: 'active',
        not_before: toSqlDateTime(notBefore),
        not_after: toSqlDateTime(notAfter),
      },
    ],
    caRows: [],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.equal(alerts.renewalFailing.length, 1);
  assert.equal(alerts.renewalFailing[0]!.critical, false);
});

test('getVpnAlerts: certificado a punto de caducar (menos de 3 dias) -> critico', async (t) => {
  const notBefore = new Date(Date.now() - 25 * DAY);
  const notAfter = new Date(Date.now() + 2 * DAY);
  setUpMockDb({
    devices: [{ username: 'vpn-juan-laptop', platform: 'windows', renew_after_days: null, enabled: 1 }],
    certs: [
      {
        username: 'vpn-juan-laptop',
        status: 'active',
        not_before: toSqlDateTime(notBefore),
        not_after: toSqlDateTime(notAfter),
      },
    ],
    caRows: [],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.equal(alerts.renewalFailing[0]!.critical, true);
});

test('getVpnAlerts: certificado todavia dentro de plazo de renovacion -> sin alerta', async (t) => {
  const notBefore = new Date(Date.now() - 5 * DAY); // renewAfterDays=20, todavia no toca
  const notAfter = new Date(Date.now() + 25 * DAY);
  setUpMockDb({
    devices: [{ username: 'vpn-juan-laptop', platform: 'windows', renew_after_days: null, enabled: 1 }],
    certs: [
      {
        username: 'vpn-juan-laptop',
        status: 'active',
        not_before: toSqlDateTime(notBefore),
        not_after: toSqlDateTime(notAfter),
      },
    ],
    caRows: [],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.deepEqual(alerts.renewalFailing, []);
});

test('getVpnAlerts: el renewAfterDays del dispositivo sobrescribe el general', async (t) => {
  const notBefore = new Date(Date.now() - 5 * DAY);
  const notAfter = new Date(Date.now() + 25 * DAY);
  setUpMockDb({
    devices: [{ username: 'vpn-juan-laptop', platform: 'windows', renew_after_days: 3, enabled: 1 }],
    certs: [
      {
        username: 'vpn-juan-laptop',
        status: 'active',
        not_before: toSqlDateTime(notBefore),
        not_after: toSqlDateTime(notAfter),
      },
    ],
    caRows: [],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.equal(alerts.renewalFailing.length, 1); // con renewAfterDays=3 ya toca, aunque el general sea 20
});

test('getVpnAlerts: dispositivo deshabilitado no genera alertas', async (t) => {
  setUpMockDb({
    devices: [{ username: 'vpn-juan-laptop', platform: 'windows', renew_after_days: null, enabled: 0 }],
    certs: [],
    caRows: [],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.deepEqual(alerts.renewalFailing, []);
});

test('getVpnAlerts: android que caduca dentro de 30 dias sale en androidExpiringSoon', async (t) => {
  setUpMockDb({
    devices: [{ username: 'vpn-juan-phone', platform: 'android', renew_after_days: null, enabled: 1 }],
    certs: [
      {
        username: 'vpn-juan-phone',
        status: 'active',
        not_before: toSqlDateTime(new Date(Date.now() - 300 * DAY)),
        not_after: toSqlDateTime(new Date(Date.now() + 15 * DAY)),
      },
    ],
    caRows: [],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.equal(alerts.androidExpiringSoon.length, 1);
  assert.equal(alerts.androidExpiringSoon[0]!.username, 'vpn-juan-phone');
  // Android nunca cuenta como "renovacion fallida": no tiene autorrenovacion por EST.
  assert.deepEqual(alerts.renewalFailing, []);

  const gauge = await vpnAndroidExpiringGauge.get();
  assert.equal(gauge.values[0]!.value, 1);
});

test('getVpnAlerts: android que caduca en mas de 30 dias no genera alerta', async (t) => {
  setUpMockDb({
    devices: [{ username: 'vpn-juan-phone', platform: 'android', renew_after_days: null, enabled: 1 }],
    certs: [
      {
        username: 'vpn-juan-phone',
        status: 'active',
        not_before: toSqlDateTime(new Date(Date.now() - 30 * DAY)),
        not_after: toSqlDateTime(new Date(Date.now() + 300 * DAY)),
      },
    ],
    caRows: [],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.deepEqual(alerts.androidExpiringSoon, []);
});

test('getVpnAlerts: CA intermedia que caduca dentro de 90 dias', async (t) => {
  setUpMockDb({
    devices: [],
    certs: [],
    caRows: [
      { id: 1, subject: 'CN=Intermedia', not_after: toSqlDateTime(new Date(Date.now() + 60 * DAY)), status: 'active' },
      { id: 2, subject: 'CN=Otra', not_after: toSqlDateTime(new Date(Date.now() + 200 * DAY)), status: 'active' },
    ],
    estRejectionsLastHour: 0,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.equal(alerts.caExpiringSoon.length, 1);
  assert.equal(alerts.caExpiringSoon[0]!.id, 1);

  const gauge = await vpnCaExpiringGauge.get();
  assert.equal(gauge.values[0]!.value, 1);
});

test('getVpnAlerts: rechazos EST de la ultima hora y umbral fijo', async (t) => {
  setUpMockDb({
    devices: [],
    certs: [],
    caRows: [],
    estRejectionsLastHour: 7,
    settings: BASE_SETTINGS,
  });
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.equal(alerts.estRejectionsLastHour, 7);
  assert.ok(alerts.estRejectionsThreshold > 0);

  const gauge = await vpnEstRejectionsLastHourGauge.get();
  assert.equal(gauge.values[0]!.value, 7);
});

test('getVpnAlerts: se degrada a todo vacio si el modulo VPN no esta configurado', async (t) => {
  mock.method(pools.panelPool, 'query', (async () => {
    const err = new Error('no existe') as Error & { code: string };
    err.code = 'ER_NO_SUCH_TABLE';
    throw err;
  }) as never);
  t.after(() => mock.restoreAll());

  const alerts = await getVpnAlerts();
  assert.deepEqual(alerts, {
    renewalFailing: [],
    androidExpiringSoon: [],
    caExpiringSoon: [],
    estRejectionsLastHour: 0,
    estRejectionsThreshold: alerts.estRejectionsThreshold,
  });
});
