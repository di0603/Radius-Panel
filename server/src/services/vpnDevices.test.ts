import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { intToIpv4, ipv4ToInt } from '../lib/ipv4.js';
import { createDevice, firstFreeIp } from './vpnDevices.js';

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
            username: 'vpn-laptop-test',
            owner: 'Juan',
            platform: 'linux',
            tunnel_mode: 'split',
            notes: null,
            cert_days: null,
            renew_after_days: null,
            framed_ip: '192.168.10.75',
            status: 'active',
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
  owner: 'Juan',
  platform: 'linux' as const,
  tunnelMode: 'split' as const,
  notes: null,
  certDays: null,
  renewAfterDays: null,
  createdBy: null,
};

test('createDevice: escribe radcheck/radreply/radusergroup y la ficha del panel', async () => {
  const conn = makeFakeConn(connDispatcher([]));
  mock.method(pools.radiusPool, 'getConnection', (async () => conn) as never);
  mock.method(pools.radiusPool, 'query', radiusPoolQueryDispatch() as never);
  const panelQuery = mock.method(pools.panelPool, 'query', panelPoolQueryDispatch({}) as never);

  try {
    const device = await createDevice({ ...BASE_INPUT, name: 'laptop-test' });

    assert.equal(device.username, 'vpn-laptop-test');
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
      createDevice({ ...BASE_INPUT, name: 'laptop-fail' }),
      /fallo simulado al insertar en el panel/,
    );

    // La transaccion RADIUS si se confirmo: la compensacion es manual, con DELETE.
    assert.equal(conn.committed, true);

    const deleteCalls = radiusQuery.mock.calls.filter((c) =>
      String(c.arguments[0]).startsWith('DELETE FROM'),
    );
    assert.equal(deleteCalls.length, 3);
    for (const c of deleteCalls) {
      assert.equal((c.arguments[1] as { u: string }).u, 'vpn-laptop-fail');
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
      createDevice({ ...BASE_INPUT, name: 'laptop-full' }),
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
