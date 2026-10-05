import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { intToIpv4, ipv4ToInt } from '../lib/ipv4.js';
import { changeDeviceProfile, createDevice, type CreateDeviceInput } from './vpnDevices.js';
import type { AccessProfile } from './vpnAccessProfiles.js';

/**
 * Perfil de acceso por dispositivo: la IP sale del rango del perfil (alta y
 * cambio de perfil), un rango lleno o sin configurar falla con error claro
 * sin asignar nunca de otro rango, y el cambio de perfil desconecta la sesion
 * (simulada: ningun Disconnect-Request real) o avisa si no se pudo.
 * radiusPool/panelPool se sustituyen con mock.method: no se toca ninguna base real.
 */

const RANGES: Record<string, [string, string]> = {
  internet_only: ['192.168.10.100', '192.168.10.102'],
  lan_full: ['192.168.10.105', '192.168.10.109'],
  internet_lan_full: ['192.168.10.75', '192.168.10.99'],
};

function allIps(start: string, end: string): string[] {
  const ips: string[] = [];
  for (let n = ipv4ToInt(start); n <= ipv4ToInt(end); n++) ips.push(intToIpv4(n));
  return ips;
}

interface World {
  /** radreply: Framed-IP-Address por username (y otros usuarios "ocupando" IPs). */
  radreply: Map<string, string>;
  /** Ficha del panel del dispositivo bajo prueba. */
  device: { username: string; access_profile: string; framed_ip: string | null } | null;
  failPanelUpdate?: boolean;
  radiusCalls: string[];
  panelCalls: { sql: string; params: Record<string, unknown> }[];
  conn: { committed: boolean; rolledBack: boolean };
}

function deviceRow(w: World) {
  const d = w.device!;
  return {
    id: 1,
    username: d.username,
    owner_user: 'diego',
    device_label: 'portatil',
    owner_name: null,
    platform: 'windows',
    tunnel_mode: 'full',
    access_profile: d.access_profile,
    notes: null,
    cert_days: null,
    renew_after_days: null,
    framed_ip: d.framed_ip,
    enabled: 1,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  };
}

function setUp(world: Partial<World> = {}): World {
  const w: World = {
    radreply: new Map(),
    device: null,
    radiusCalls: [],
    panelCalls: [],
    conn: { committed: false, rolledBack: false },
    ...world,
  };

  const conn = {
    async beginTransaction() {},
    async commit() {
      w.conn.committed = true;
    },
    async rollback() {
      w.conn.rolledBack = true;
    },
    release() {},
    async query(sql: string, params?: unknown) {
      const p = (params ?? {}) as Record<string, string>;
      w.radiusCalls.push(sql);
      if (sql.includes("SELECT value FROM radreply WHERE attribute = 'Framed-IP-Address'")) {
        return [[...w.radreply.values()].map((value) => ({ value })), []];
      }
      if (sql.startsWith('UPDATE radreply SET value')) {
        const had = w.radreply.has(p.u!);
        if (had) w.radreply.set(p.u!, p.ip!);
        return [{ affectedRows: had ? 1 : 0 }, []];
      }
      if (sql.startsWith('INSERT INTO radreply')) {
        w.radreply.set(p.u!, p.ip!);
        return [{}, []];
      }
      return [{}, []];
    },
  };
  mock.method(pools.radiusPool, 'getConnection', (async () => conn) as never);
  mock.method(pools.radiusPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, string>;
    w.radiusCalls.push(sql);
    if (sql.includes('UNION SELECT 1 FROM radreply')) return [[], []]; // usernameExists: libre
    if (sql.startsWith('UPDATE radreply SET value')) {
      w.radreply.set(p.u!, p.ip!);
      return [{}, []];
    }
    if (sql.startsWith('DELETE FROM')) return [{}, []];
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);

  mock.method(pools.panelPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, string>;
    w.panelCalls.push({ sql, params: p });
    if (sql.includes('FROM panel_vpn_profile_ranges')) {
      return [
        Object.entries(RANGES).map(([profile, [start, end]]) => ({
          profile,
          range_start: start,
          range_end: end,
        })),
        [],
      ];
    }
    if (sql.includes('FROM panel_vpn_settings')) {
      const err = new Error('sin tabla') as Error & { code: string };
      err.code = 'ER_NO_SUCH_TABLE';
      throw err;
    }
    if (sql.startsWith('SELECT * FROM panel_vpn_devices WHERE username')) {
      return [w.device ? [deviceRow(w)] : [], []];
    }
    if (sql.startsWith('INSERT INTO panel_vpn_devices')) {
      w.device = {
        username: p.username!,
        access_profile: p.accessProfile!,
        framed_ip: p.framedIp!,
      };
      return [{ insertId: 1 }, []];
    }
    if (sql.startsWith('SELECT * FROM panel_vpn_devices WHERE id')) return [[deviceRow(w)], []];
    if (sql.startsWith('UPDATE panel_vpn_devices SET access_profile')) {
      if (w.failPanelUpdate) throw new Error('fallo simulado al actualizar la ficha');
      w.device = { username: p.u!, access_profile: p.profile!, framed_ip: p.ip! };
      return [{}, []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);
  return w;
}

const BASE: Omit<CreateDeviceInput, 'accessProfile'> = {
  ownerUser: 'diego',
  deviceLabel: 'portatil',
  ownerName: null,
  platform: 'windows',
  tunnelMode: 'full',
  notes: null,
  certDays: null,
  renewAfterDays: null,
};

function radreplyInserts(w: World): number {
  return w.radiusCalls.filter((s) => s.startsWith('INSERT INTO radreply')).length;
}

/* ------------------------------------ alta ------------------------------------- */

test('createDevice: la IP sale del rango del perfil elegido y se guarda access_profile', async () => {
  const w = setUp({ radreply: new Map([['otro', '192.168.10.105']]) });
  try {
    const device = await createDevice({ ...BASE, accessProfile: 'lan_full' });
    assert.equal(device.framedIp, '192.168.10.106'); // la .105 de lan_full ya estaba ocupada
    assert.equal(device.accessProfile, 'lan_full');
  } finally {
    mock.restoreAll();
  }
  assert.equal(w.device?.access_profile, 'lan_full');
});

test('createDevice: sin perfil explicito, internet_only (el valor por defecto de las altas nuevas)', async () => {
  const w = setUp();
  try {
    const device = await createDevice({ ...BASE });
    assert.equal(device.accessProfile, 'internet_only');
    assert.equal(device.framedIp, '192.168.10.100');
  } finally {
    mock.restoreAll();
  }
  assert.equal(w.device?.access_profile, 'internet_only');
});

test('createDevice: rango del perfil lleno -> error claro y NO se asigna una IP de otro rango', async () => {
  // internet_only 100-102 lleno; lan_full e internet_lan_full tienen huecos libres.
  const w = setUp({
    radreply: new Map(allIps('192.168.10.100', '192.168.10.102').map((ip, i) => [`u${i}`, ip])),
  });
  try {
    await assert.rejects(
      createDevice({ ...BASE, accessProfile: 'internet_only' }),
      (err: Error & { status?: number }) => {
        assert.equal(err.status, 409);
        assert.match(
          err.message,
          /No quedan IPs libres en el rango del perfil internet_only \(192\.168\.10\.100-192\.168\.10\.102\)/,
        );
        return true;
      },
    );
  } finally {
    mock.restoreAll();
  }
  assert.equal(radreplyInserts(w), 0);
  assert.equal(w.conn.committed, false);
  assert.equal(w.conn.rolledBack, true);
  assert.equal(w.device, null);
});

test('createDevice: perfil sin rango configurado -> error claro sin escribir nada en RADIUS', async () => {
  const w = setUp();
  try {
    await assert.rejects(
      createDevice({ ...BASE, accessProfile: 'lan_restricted' }), // no esta en RANGES
      /lan_restricted no tiene rango de IPs configurado/,
    );
  } finally {
    mock.restoreAll();
  }
  assert.ok(!w.radiusCalls.some((sql) => sql.startsWith('INSERT') || sql.includes('FOR UPDATE')));
  assert.equal(w.conn.committed, false);
  assert.equal(w.device, null);
});

/* ------------------------------- cambio de perfil ------------------------------ */

function existing(profile: AccessProfile, ip: string | null): World['device'] {
  return { username: 'vpn-diego-portatil', access_profile: profile, framed_ip: ip };
}

test('changeDeviceProfile: reasigna la IP del rango nuevo, actualiza radreply y panel y desconecta la sesion', async () => {
  const w = setUp({
    device: existing('internet_lan_full', '192.168.10.77'),
    radreply: new Map([['vpn-diego-portatil', '192.168.10.77']]),
  });
  const disconnected: string[] = [];
  try {
    const result = await changeDeviceProfile('vpn-diego-portatil', 'internet_only', {
      disconnect: async (username) => {
        disconnected.push(username);
        return { total: 1, results: [], errors: [] };
      },
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.before, {
      accessProfile: 'internet_lan_full',
      framedIp: '192.168.10.77',
    });
    assert.deepEqual(result.after, { accessProfile: 'internet_only', framedIp: '192.168.10.100' });
    assert.deepEqual(result.disconnect, { attempted: true, ok: true, sessions: 1, error: null });
    assert.equal(result.device.accessProfile, 'internet_only');
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(disconnected, ['vpn-diego-portatil']);
  assert.equal(w.radreply.get('vpn-diego-portatil'), '192.168.10.100');
  assert.equal(w.conn.committed, true);
  assert.equal(w.device?.access_profile, 'internet_only');
  assert.equal(w.device?.framed_ip, '192.168.10.100');
});

test('changeDeviceProfile: si la desconexion falla, el cambio queda guardado y se avisa (aplica en la proxima conexion)', async () => {
  const w = setUp({
    device: existing('internet_lan_full', '192.168.10.77'),
    radreply: new Map([['vpn-diego-portatil', '192.168.10.77']]),
  });
  try {
    const result = await changeDeviceProfile('vpn-diego-portatil', 'lan_full', {
      disconnect: async () => {
        throw new Error('La desconexion de sesiones esta deshabilitada (COA_ENABLED=false)');
      },
    });
    assert.equal(result.changed, true);
    assert.equal(result.disconnect.attempted, true);
    assert.equal(result.disconnect.ok, false);
    assert.match(result.disconnect.error ?? '', /COA_ENABLED=false/);
    assert.equal(result.after.framedIp, '192.168.10.105');
  } finally {
    mock.restoreAll();
  }
  assert.equal(w.device?.access_profile, 'lan_full');
});

test('changeDeviceProfile: errores parciales de Disconnect (NAS no responde) -> ok=false con el detalle', async () => {
  setUp({
    device: existing('internet_lan_full', '192.168.10.77'),
    radreply: new Map([['vpn-diego-portatil', '192.168.10.77']]),
  });
  try {
    const result = await changeDeviceProfile('vpn-diego-portatil', 'lan_full', {
      disconnect: async () => ({
        total: 1,
        results: [],
        errors: [{ acctuniqueid: 'abc', error: 'timeout' }],
      }),
    });
    assert.equal(result.disconnect.ok, false);
    assert.equal(result.disconnect.error, 'timeout');
    assert.equal(result.disconnect.sessions, 1);
  } finally {
    mock.restoreAll();
  }
});

test('changeDeviceProfile: mismo perfil -> sin cambios, sin tocar RADIUS ni desconectar', async () => {
  const w = setUp({
    device: existing('internet_only', '192.168.10.100'),
    radreply: new Map([['vpn-diego-portatil', '192.168.10.100']]),
  });
  let called = 0;
  try {
    const result = await changeDeviceProfile('vpn-diego-portatil', 'internet_only', {
      disconnect: async () => {
        called++;
        return { total: 0, results: [], errors: [] };
      },
    });
    assert.equal(result.changed, false);
    assert.equal(result.disconnect.attempted, false);
  } finally {
    mock.restoreAll();
  }
  assert.equal(called, 0);
  assert.equal(w.conn.committed, false);
});

test('changeDeviceProfile: rango del perfil nuevo lleno -> error claro, nada cambia y no se desconecta', async () => {
  const full = new Map(allIps('192.168.10.105', '192.168.10.109').map((ip, i) => [`u${i}`, ip]));
  full.set('vpn-diego-portatil', '192.168.10.77');
  const w = setUp({ device: existing('internet_lan_full', '192.168.10.77'), radreply: full });
  let called = 0;
  try {
    await assert.rejects(
      changeDeviceProfile('vpn-diego-portatil', 'lan_full', {
        disconnect: async () => {
          called++;
          return { total: 0, results: [], errors: [] };
        },
      }),
      /No quedan IPs libres en el rango del perfil lan_full/,
    );
  } finally {
    mock.restoreAll();
  }
  assert.equal(called, 0);
  assert.equal(w.conn.rolledBack, true);
  assert.equal(w.radreply.get('vpn-diego-portatil'), '192.168.10.77'); // sin tocar
  assert.equal(w.device?.access_profile, 'internet_lan_full');
  assert.ok(!w.panelCalls.some((c) => c.sql.startsWith('UPDATE panel_vpn_devices')));
});

test('changeDeviceProfile: si falla la ficha del panel, se deshace el cambio de IP en radreply', async () => {
  const w = setUp({
    device: existing('internet_lan_full', '192.168.10.77'),
    radreply: new Map([['vpn-diego-portatil', '192.168.10.77']]),
    failPanelUpdate: true,
  });
  try {
    await assert.rejects(
      changeDeviceProfile('vpn-diego-portatil', 'internet_only', {
        disconnect: async () => ({ total: 0, results: [], errors: [] }),
      }),
      /fallo simulado al actualizar la ficha/,
    );
  } finally {
    mock.restoreAll();
  }
  assert.equal(w.radreply.get('vpn-diego-portatil'), '192.168.10.77');
});

test('changeDeviceProfile: un dispositivo dado de baja no se puede reasignar', async () => {
  setUp({ device: existing('internet_only', null) });
  try {
    await assert.rejects(
      changeDeviceProfile('vpn-diego-portatil', 'lan_full'),
      (err: Error & { status?: number }) => err.status === 409 && /dado de baja/.test(err.message),
    );
  } finally {
    mock.restoreAll();
  }
});

test('changeDeviceProfile: dispositivo inexistente -> 404', async () => {
  setUp({ device: null });
  try {
    await assert.rejects(
      changeDeviceProfile('vpn-nadie', 'lan_full'),
      (err: Error & { status?: number }) => err.status === 404,
    );
  } finally {
    mock.restoreAll();
  }
});
