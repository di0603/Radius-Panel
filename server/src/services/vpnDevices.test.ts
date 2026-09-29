import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { config } from '../config.js';
import { intToIpv4, ipv4ToInt } from '../lib/ipv4.js';
import {
  NAME_PART_RE,
  buildDeviceUsername,
  createDevice,
  firstFreeIp,
  generateEnrollToken,
  getDeviceDetail,
  setDeviceEnabled,
} from './vpnDevices.js';

function writeTempSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'radius-panel-profile-key-'));
  const keyPath = join(dir, 'key.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  return { keyPath, publicKey };
}

/* ------------------------------- firstFreeIp ------------------------------ */

test('firstFreeIp: rango vacio devuelve la primera IP', () => {
  assert.equal(firstFreeIp('192.168.10.75', '192.168.10.99', []), '192.168.10.75');
});

test('firstFreeIp: salta las IPs ya usadas al principio del rango', () => {
  assert.equal(
    firstFreeIp('192.168.10.75', '192.168.10.99', ['192.168.10.75', '192.168.10.76']),
    '192.168.10.77',
  );
});

test('firstFreeIp: encuentra un hueco en medio del rango', () => {
  assert.equal(
    firstFreeIp('192.168.10.75', '192.168.10.77', ['192.168.10.75', '192.168.10.77']),
    '192.168.10.76',
  );
});

test('firstFreeIp: rango lleno devuelve null', () => {
  assert.equal(
    firstFreeIp('192.168.10.75', '192.168.10.76', ['192.168.10.75', '192.168.10.76']),
    null,
  );
});

test('firstFreeIp: rango de una sola IP, libre y ocupada', () => {
  assert.equal(firstFreeIp('192.168.10.80', '192.168.10.80', []), '192.168.10.80');
  assert.equal(firstFreeIp('192.168.10.80', '192.168.10.80', ['192.168.10.80']), null);
});

/* -------------------------- createDevice (mocks) --------------------------- */
/*
 * radiusPool/panelPool son pools mysql2 reales (no hay MySQL en este entorno
 * de desarrollo, ver memoria del proyecto): se sustituyen sus metodos con
 * mock.method de node:test para probar la orquestacion de la transaccion —
 * en concreto, que un fallo al insertar en panel_vpn_devices deshace a mano
 * las filas de radcheck/radreply/radusergroup ya confirmadas.
 */

function allIpsInRange(start: string, end: string): string[] {
  const ips: string[] = [];
  for (let n = ipv4ToInt(start); n <= ipv4ToInt(end); n++) ips.push(intToIpv4(n));
  return ips;
}

type QueryDispatch = (sql: string, params?: unknown) => unknown;

function makeFakeConn(dispatch: QueryDispatch) {
  const calls: string[] = [];
  const conn = {
    committed: false,
    rolledBack: false,
    released: false,
    calls,
    async beginTransaction() {},
    async commit() {
      conn.committed = true;
    },
    async rollback() {
      conn.rolledBack = true;
    },
    release() {
      conn.released = true;
    },
    async query(sql: string, params?: unknown) {
      calls.push(sql);
      return dispatch(sql, params);
    },
  };
  return conn;
}

function connDispatcher(usedIps: string[]): QueryDispatch {
  return (sql) => {
    if (sql.includes("SELECT value FROM radreply WHERE attribute = 'Framed-IP-Address'")) {
      return [usedIps.map((v) => ({ value: v })), []];
    }
    return [{}, []];
  };
}

function radiusPoolQueryDispatch(): QueryDispatch {
  return (sql) => {
    if (sql.includes('UNION SELECT 1 FROM radreply')) return [[], []]; // usernameExists: libre
    if (sql.startsWith('DELETE FROM')) return [{}, []];
    throw new Error(`radiusPool.query no esperado en el test: ${sql}`);
  };
}

function panelPoolQueryDispatch(opts: { failDeviceInsert?: boolean }): QueryDispatch {
  return (sql) => {
    if (sql.includes('FROM panel_vpn_settings')) {
      const err = new Error('sin tabla') as Error & { code: string };
      err.code = 'ER_NO_SUCH_TABLE'; // getVpnSettings se degrada a DEFAULT_VPN_SETTINGS
      throw err;
    }
    if (sql.includes('INSERT INTO panel_vpn_devices')) {
      if (opts.failDeviceInsert) throw new Error('fallo simulado al insertar en el panel');
      return [{ insertId: 1 }, []];
    }
    if (sql.startsWith('SELECT * FROM panel_vpn_devices')) {
      return [
        [
          {
            id: 1,
            username: 'vpn-juan-laptop-test',
            owner_user: 'juan',
            device_label: 'laptop-test',
            owner_name: 'Juan',
            platform: 'linux',
            tunnel_mode: 'split',
            notes: null,
            cert_days: null,
            renew_after_days: null,
            framed_ip: '192.168.10.75',
            enabled: 1,
            created_at: '2026-01-01 00:00:00',
            updated_at: '2026-01-01 00:00:00',
          },
        ],
        [],
      ];
    }
    throw new Error(`panelPool.query no esperado en el test: ${sql}`);
  };
}

const BASE_INPUT = {
  ownerUser: 'juan',
  ownerName: 'Juan',
  platform: 'linux' as const,
  tunnelMode: 'split' as const,
  notes: null,
  certDays: null,
  renewAfterDays: null,
};

test('createDevice: escribe radcheck/radreply/radusergroup y la ficha del panel', async () => {
  const conn = makeFakeConn(connDispatcher([]));
  mock.method(pools.radiusPool, 'getConnection', (async () => conn) as never);
  mock.method(pools.radiusPool, 'query', radiusPoolQueryDispatch() as never);
  const panelQuery = mock.method(pools.panelPool, 'query', panelPoolQueryDispatch({}) as never);

  try {
    const device = await createDevice({ ...BASE_INPUT, deviceLabel: 'laptop-test' });

    assert.equal(device.username, 'vpn-juan-laptop-test');
    assert.equal(device.framedIp, '192.168.10.75');
    assert.equal(conn.committed, true);
    assert.equal(conn.rolledBack, false);
    assert.equal(conn.released, true);
    assert.ok(conn.calls.some((s) => s.includes('INSERT INTO radcheck')));
    assert.ok(conn.calls.some((s) => s.includes('INSERT INTO radreply')));
    assert.ok(conn.calls.some((s) => s.includes('INSERT INTO radusergroup')));

    const insertCall = panelQuery.mock.calls.find((c) =>
      String(c.arguments[0]).includes('INSERT INTO panel_vpn_devices'),
    );
    assert.equal((insertCall?.arguments[1] as { framedIp: string }).framedIp, '192.168.10.75');

    // Bloquea las filas de radreply leidas: sin esto, dos altas simultaneas
    // podrian elegir la misma IP libre (ver el comentario en vpnDevices.ts).
    assert.ok(
      conn.calls.some(
        (s) => s.includes("SELECT value FROM radreply WHERE attribute = 'Framed-IP-Address'") &&
          s.includes('FOR UPDATE'),
      ),
    );
  } finally {
    mock.restoreAll();
  }
});

test('createDevice: si falla el insert en el panel, deshace radcheck/radreply/radusergroup', async () => {
  const conn = makeFakeConn(connDispatcher([]));
  mock.method(pools.radiusPool, 'getConnection', (async () => conn) as never);
  const radiusQuery = mock.method(pools.radiusPool, 'query', radiusPoolQueryDispatch() as never);
  mock.method(
    pools.panelPool,
    'query',
    panelPoolQueryDispatch({ failDeviceInsert: true }) as never,
  );

  try {
    await assert.rejects(
      createDevice({ ...BASE_INPUT, deviceLabel: 'laptop-fail' }),
      /fallo simulado al insertar en el panel/,
    );

    // La transaccion RADIUS si se confirmo: la compensacion es manual, con DELETE.
    assert.equal(conn.committed, true);

    const deleteCalls = radiusQuery.mock.calls.filter((c) =>
      String(c.arguments[0]).startsWith('DELETE FROM'),
    );
    assert.equal(deleteCalls.length, 3);
    for (const c of deleteCalls) {
      assert.equal((c.arguments[1] as { u: string }).u, 'vpn-juan-laptop-fail');
    }
  } finally {
    mock.restoreAll();
  }
});

test('createDevice: sin IPs libres, no toca radcheck/radreply/radusergroup ni el panel', async () => {
  const usedIps = allIpsInRange('192.168.10.75', '192.168.10.99'); // rango por defecto, lleno
  const conn = makeFakeConn(connDispatcher(usedIps));
  mock.method(pools.radiusPool, 'getConnection', (async () => conn) as never);
  mock.method(pools.radiusPool, 'query', radiusPoolQueryDispatch() as never);
  const panelQuery = mock.method(pools.panelPool, 'query', panelPoolQueryDispatch({}) as never);

  try {
    await assert.rejects(
      createDevice({ ...BASE_INPUT, deviceLabel: 'laptop-full' }),
      /[Nn]o quedan IPs libres/,
    );

    assert.equal(conn.committed, false);
    assert.equal(conn.rolledBack, true);
    assert.ok(!conn.calls.some((s) => s.includes('INSERT INTO radcheck')));
    assert.ok(
      !panelQuery.mock.calls.some((c) =>
        String(c.arguments[0]).includes('INSERT INTO panel_vpn_devices'),
      ),
    );
  } finally {
    mock.restoreAll();
  }
});

test('buildDeviceUsername: vpn-<owner_user>-<device_label>', () => {
  assert.equal(buildDeviceUsername('juan', 'laptop'), 'vpn-juan-laptop');
});

test('NAME_PART_RE: exige 2-32 caracteres, solo minusculas/numeros/guiones', () => {
  assert.match('ab', NAME_PART_RE);
  assert.match('a'.repeat(32), NAME_PART_RE); // limite exacto: cabe
  assert.match('juan-perez-2', NAME_PART_RE);
  assert.doesNotMatch('a', NAME_PART_RE); // demasiado corto
  assert.doesNotMatch('a'.repeat(33), NAME_PART_RE); // demasiado largo
  assert.doesNotMatch('Juan', NAME_PART_RE); // mayusculas
  assert.doesNotMatch('juan_perez', NAME_PART_RE); // guion bajo
});

test('createDevice: el mismo device_label para dos owner_user distintos crea dos dispositivos independientes (mismo equipo, un usuario cada uno)', async () => {
  // La unicidad la exige usernameExists() sobre el username COMPLETO
  // (vpn-<owner>-<label>), no sobre device_label por si solo: dos filas para
  // "el mismo equipo" con dueños distintos deben convivir sin chocar.
  const usedIps: string[] = [];
  const insertedRows: Array<{ id: number; username: string; owner_user: string; framed_ip: string }> = [];

  mock.method(pools.radiusPool, 'query', ((sql: string) => {
    if (sql.includes('UNION SELECT 1 FROM radreply')) return [[], []]; // usernameExists: siempre libre
    if (sql.startsWith('DELETE FROM')) return [{}, []];
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);
  mock.method(pools.radiusPool, 'getConnection', (async () => makeFakeConn(connDispatcher(usedIps))) as never);
  mock.method(pools.panelPool, 'query', ((sql: string, params?: unknown) => {
    if (sql.includes('FROM panel_vpn_settings')) {
      const err = new Error('sin tabla') as Error & { code: string };
      err.code = 'ER_NO_SUCH_TABLE';
      throw err;
    }
    if (sql.includes('INSERT INTO panel_vpn_devices')) {
      const p = params as { username: string; ownerUser: string; framedIp: string };
      const row = { id: insertedRows.length + 1, username: p.username, owner_user: p.ownerUser, framed_ip: p.framedIp };
      insertedRows.push(row);
      return [{ insertId: row.id }, []];
    }
    if (sql.startsWith('SELECT * FROM panel_vpn_devices')) {
      const p = params as { id: number };
      const row = insertedRows.find((r) => r.id === p.id)!;
      return [
        [
          {
            ...row,
            device_label: 'router-salon',
            owner_name: null,
            platform: 'linux',
            tunnel_mode: 'split',
            notes: null,
            cert_days: null,
            renew_after_days: null,
            enabled: 1,
            created_at: '2026-01-01 00:00:00',
            updated_at: '2026-01-01 00:00:00',
          },
        ],
        [],
      ];
    }
    throw new Error(`panelPool.query no esperado en el test: ${sql}`);
  }) as never);

  try {
    const first = await createDevice({ ...BASE_INPUT, ownerUser: 'juan', deviceLabel: 'router-salon' });
    usedIps.push(first.framedIp!);
    const second = await createDevice({ ...BASE_INPUT, ownerUser: 'maria', deviceLabel: 'router-salon' });

    assert.equal(first.username, 'vpn-juan-router-salon');
    assert.equal(second.username, 'vpn-maria-router-salon');
    assert.notEqual(first.framedIp, second.framedIp); // IPs distintas, cada fila con la suya
  } finally {
    mock.restoreAll();
  }
});

test('createDevice: rechaza un nombre ya usado en RADIUS sin llegar a abrir conexion', async () => {
  const getConnection = mock.method(pools.radiusPool, 'getConnection', (async () => {
    throw new Error('no deberia abrir conexion si el username ya existe');
  }) as never);
  mock.method(pools.radiusPool, 'query', ((sql: string) => {
    if (sql.includes('UNION SELECT 1 FROM radreply')) return [[{ 1: 1 }], []]; // ya existe
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);

  try {
    await assert.rejects(
      createDevice({ ...BASE_INPUT, deviceLabel: 'laptop-dup' }),
      /Ya existe un usuario RADIUS/,
    );
    assert.equal(getConnection.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
  }
});

/* ------------------------- setDeviceEnabled / getDeviceDetail ------------------------- */

function deviceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    username: 'vpn-juan-laptop-test',
    owner_user: 'juan',
    device_label: 'laptop-test',
    owner_name: 'Juan',
    platform: 'linux',
    tunnel_mode: 'split',
    notes: null,
    cert_days: null,
    renew_after_days: null,
    framed_ip: '192.168.10.75',
    enabled: 1,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

test('setDeviceEnabled(false): desactiva con Auth-Type := Reject (no borra nada de RADIUS)', async () => {
  mock.method(pools.panelPool, 'query', ((sql: string) => {
    if (sql.includes('SELECT * FROM panel_vpn_devices')) return [[deviceRow()], []];
    if (sql.includes('UPDATE panel_vpn_devices SET enabled')) return [{}, []];
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);
  const radiusQuery = mock.method(pools.radiusPool, 'query', ((sql: string) => {
    if (sql.includes('UNION SELECT 1 FROM radreply')) return [[{ 1: 1 }], []]; // usernameExists
    if (sql.includes('SELECT id FROM radcheck WHERE username')) return [[], []]; // sin Auth-Type todavia
    if (sql.includes('INSERT INTO radcheck')) return [{}, []];
    if (sql.includes('SELECT acctuniqueid FROM radacct')) return [[], []]; // sin sesiones activas
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);

  try {
    await setDeviceEnabled('vpn-juan-laptop-test', false);

    const insertCalls = radiusQuery.mock.calls.filter((c) =>
      String(c.arguments[0]).includes('INSERT INTO radcheck'),
    );
    assert.equal(insertCalls.length, 1);
    assert.ok(
      radiusQuery.mock.calls.some(
        (c) =>
          String(c.arguments[0]).includes('INSERT INTO radcheck') &&
          String(c.arguments[0]).includes("'Auth-Type', ':=', 'Reject'"),
      ),
    );
  } finally {
    mock.restoreAll();
  }
});

test('getDeviceDetail: el renewAfterDays del dispositivo sobrescribe el general', async () => {
  const notBefore = '2026-01-01 00:00:00';
  mock.method(pools.panelPool, 'query', ((sql: string) => {
    if (sql.includes('SELECT * FROM panel_vpn_devices')) {
      return [[deviceRow({ renew_after_days: 5 })], []];
    }
    if (sql.includes('FROM panel_vpn_settings')) {
      return [
        [
          {
            vpn_fqdn: 'vpn.example.com',
            pool_start: '192.168.10.75',
            pool_end: '192.168.10.99',
            dns: '',
            device_cert_days: 200,
            renew_after_days: 99,
            overlap_hours: 48,
            android_cert_days: 365,
          },
        ],
        [],
      ];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);
  mock.method(pools.radiusPool, 'query', ((sql: string) => {
    if (sql.includes('FROM vpn_certificates')) {
      return [
        [
          {
            serial: 'aa',
            status: 'active',
            not_before: notBefore,
            not_after: '2027-01-01 00:00:00',
            created_at: notBefore,
            revoked_at: null,
            revoke_reason: null,
          },
        ],
        [],
      ];
    }
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);

  try {
    const detail = await getDeviceDetail('vpn-juan-laptop-test');
    const expected = new Date(Date.parse(`${notBefore.replace(' ', 'T')}Z`) + 5 * 86_400_000);
    assert.equal(detail.nextRenewalExpectedAt, expected.toISOString());
  } finally {
    mock.restoreAll();
  }
});

/* ---------------------------- generateEnrollToken --------------------------- */

test('generateEnrollToken: sin VPN_PROFILE_SIGNING_KEY, devuelve el token sin perfil ni QR (no bloquea el alta manual por EST)', async () => {
  const prevKey = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = undefined;

  const conn = makeFakeConn((sql) => {
    if (sql.includes('INSERT INTO panel_vpn_enroll_tokens')) return [{ insertId: 7 }, []];
    return [{}, []];
  });
  mock.method(pools.panelPool, 'getConnection', (async () => conn) as never);
  mock.method(pools.panelPool, 'query', ((sql: string) => {
    if (sql.startsWith('SELECT * FROM panel_vpn_devices WHERE username')) {
      return [[{ username: 'vpn-juan-laptop-test', tunnel_mode: 'full' }], []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  try {
    const result = await generateEnrollToken('vpn-juan-laptop-test', 1);
    assert.equal(result.id, 7);
    assert.ok(result.token.length > 0);
    assert.equal(result.profile, null);
    assert.equal(result.profileQrDataUrl, null);
    assert.equal(result.profileFilename, null);
  } finally {
    mock.restoreAll();
    config.vpnProfileSigning.keyPath = prevKey;
  }
});

test('generateEnrollToken: con VPN_PROFILE_SIGNING_KEY configurada, incluye un perfil firmado (con el token embebido) y un QR', async () => {
  const { keyPath, publicKey } = writeTempSigningKey();
  const prevKey = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;

  const conn = makeFakeConn((sql) => {
    if (sql.includes('INSERT INTO panel_vpn_enroll_tokens')) return [{ insertId: 9 }, []];
    return [{}, []];
  });
  mock.method(pools.panelPool, 'getConnection', (async () => conn) as never);
  mock.method(pools.panelPool, 'query', ((sql: string) => {
    if (sql.startsWith('SELECT * FROM panel_vpn_devices WHERE username')) {
      return [[{ username: 'vpn-juan-laptop-test', tunnel_mode: 'split' }], []];
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
            renew_after_days: 20,
            overlap_hours: 48,
            android_cert_days: 365,
            est_url: 'https://est.example.com:8443',
            min_app_version: '1.0.0',
          },
        ],
        [],
      ];
    }
    if (sql.includes('FROM panel_pki_ca WHERE status IN')) {
      return [
        [{ cert_pem: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----', root_cert_pem: null }],
        [],
      ];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  try {
    const result = await generateEnrollToken('vpn-juan-laptop-test', 1);
    assert.ok(result.profile);
    assert.equal(result.profileFilename, 'vpn-juan-laptop-test.didevvpn');

    const payloadBytes = Buffer.from(result.profile!.payload, 'base64url');
    const signatureBytes = Buffer.from(result.profile!.signature, 'base64url');
    assert.equal(verify(null, payloadBytes, publicKey, signatureBytes), true);

    const decoded = JSON.parse(payloadBytes.toString('utf8'));
    assert.equal(decoded.enrollToken, result.token); // el perfil lleva embebido justo el token recien generado
    assert.equal(decoded.tunnelMode, 'split');
    assert.match(result.profileQrDataUrl!, /^data:image\/png;base64,/);
  } finally {
    mock.restoreAll();
    config.vpnProfileSigning.keyPath = prevKey;
  }
});

test('generateEnrollToken: si falla construir el perfil (p.ej. sin CA configurada), el token generado sigue siendo valido', async () => {
  const { keyPath } = writeTempSigningKey();
  const prevKey = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;

  const conn = makeFakeConn((sql) => {
    if (sql.includes('INSERT INTO panel_vpn_enroll_tokens')) return [{ insertId: 11 }, []];
    return [{}, []];
  });
  mock.method(pools.panelPool, 'getConnection', (async () => conn) as never);
  mock.method(pools.panelPool, 'query', ((sql: string) => {
    if (sql.startsWith('SELECT * FROM panel_vpn_devices WHERE username')) {
      return [[{ username: 'vpn-juan-laptop-test', tunnel_mode: 'full' }], []];
    }
    if (sql.includes('FROM panel_vpn_settings')) {
      const err = new Error('sin tabla') as Error & { code: string };
      err.code = 'ER_NO_SUCH_TABLE';
      throw err;
    }
    if (sql.includes('FROM panel_pki_ca WHERE status IN')) return [[], []];
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  try {
    const result = await generateEnrollToken('vpn-juan-laptop-test', 1);
    assert.equal(result.id, 11);
    assert.ok(result.token.length > 0); // el token sigue siendo valido...
    assert.equal(result.profile, null); // ...aunque no se haya podido construir el perfil
  } finally {
    mock.restoreAll();
    config.vpnProfileSigning.keyPath = prevKey;
  }
});
