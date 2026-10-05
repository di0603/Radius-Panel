import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import {
  ACCESS_PROFILES,
  emptyRanges,
  getProfileRanges,
  pickFreeIpInRange,
  requireProfileRange,
  setProfileRanges,
  validateProfileRanges,
  type ProfileRanges,
  type RangeValidationContext,
} from './vpnAccessProfiles.js';

/**
 * Rangos de IP por perfil: validacion pura (LAN, solapes, DHCP, IPs reservadas,
 * dispositivos existentes), reparto de IP dentro del rango y guardado con la
 * base de datos simulada (no se toca ninguna base real).
 */

const CTX: RangeValidationContext = { lanCidr: '192.168.10.0/24' };

function ranges(
  partial: Partial<Record<(typeof ACCESS_PROFILES)[number], [string, string]>>,
): ProfileRanges {
  const r = emptyRanges();
  for (const [profile, range] of Object.entries(partial)) {
    r[profile as keyof ProfileRanges] = { rangeStart: range![0], rangeEnd: range![1] };
  }
  return r;
}

/* ------------------------------ validateProfileRanges --------------------------- */

test('validateProfileRanges: rangos validos, sin solapes, dentro de la LAN', () => {
  const r = ranges({
    internet_only: ['192.168.10.100', '192.168.10.109'],
    lan_full: ['192.168.10.110', '192.168.10.119'],
    internet_lan_full: ['192.168.10.75', '192.168.10.99'],
  });
  assert.deepEqual(validateProfileRanges(r, CTX), []);
});

test('validateProfileRanges: sin ningun rango tambien es valido (no admite altas, pero no es un error)', () => {
  assert.deepEqual(validateProfileRanges(emptyRanges(), CTX), []);
});

test('validateProfileRanges: rechaza solapes entre perfiles', () => {
  const r = ranges({
    internet_only: ['192.168.10.100', '192.168.10.110'],
    lan_full: ['192.168.10.110', '192.168.10.120'], // comparte la .110
  });
  const problems = validateProfileRanges(r, CTX);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /lan_full y internet_only se solapan/);
});

test('validateProfileRanges: dos rangos contiguos (sin compartir IP) no se solapan', () => {
  const r = ranges({
    internet_only: ['192.168.10.100', '192.168.10.109'],
    lan_full: ['192.168.10.110', '192.168.10.119'],
  });
  assert.deepEqual(validateProfileRanges(r, CTX), []);
});

test('validateProfileRanges: rechaza un rango fuera de la LAN', () => {
  const r = ranges({ internet_only: ['10.0.0.5', '10.0.0.9'] });
  assert.match(validateProfileRanges(r, CTX)[0]!, /dentro de 192\.168\.10\.0\/24/);
  const r2 = ranges({ internet_only: ['192.168.10.200', '192.168.11.5'] });
  assert.match(validateProfileRanges(r2, CTX)[0]!, /dentro de 192\.168\.10\.0\/24/);
});

test('validateProfileRanges: rechaza la direccion de red y la de broadcast', () => {
  assert.equal(
    validateProfileRanges(ranges({ lan_full: ['192.168.10.0', '192.168.10.5'] }), CTX).length,
    1,
  );
  assert.equal(
    validateProfileRanges(ranges({ lan_full: ['192.168.10.250', '192.168.10.255'] }), CTX).length,
    1,
  );
});

test('validateProfileRanges: rechaza inicio > fin e IPs mal formadas', () => {
  assert.match(
    validateProfileRanges(ranges({ lan_full: ['192.168.10.120', '192.168.10.110'] }), CTX)[0]!,
    /va despues del fin/,
  );
  assert.match(
    validateProfileRanges(ranges({ lan_full: ['192.168.10.999', '192.168.10.110'] }), CTX)[0]!,
    /IPv4 validas/,
  );
  const half = emptyRanges();
  half.lan_full = { rangeStart: '192.168.10.100', rangeEnd: null };
  assert.match(validateProfileRanges(half, CTX)[0]!, /IPv4 validas/);
});

test('validateProfileRanges: rechaza pisar el DHCP del router', () => {
  const r = ranges({ internet_only: ['192.168.10.100', '192.168.10.130'] });
  const problems = validateProfileRanges(r, {
    ...CTX,
    dhcp: { start: '192.168.10.120', end: '192.168.10.200' },
  });
  assert.match(problems[0]!, /pisa el DHCP del router/);
  // justo fuera: valido
  assert.deepEqual(
    validateProfileRanges(ranges({ internet_only: ['192.168.10.100', '192.168.10.119'] }), {
      ...CTX,
      dhcp: { start: '192.168.10.120', end: '192.168.10.200' },
    }),
    [],
  );
});

test('validateProfileRanges: ningun rango puede contener .28, .29 ni .30', () => {
  for (const host of ['192.168.10.28', '192.168.10.29', '192.168.10.30']) {
    const r = ranges({ lan_full: [host, host] });
    const problems = validateProfileRanges(r, CTX);
    assert.equal(problems.length, 1, host);
    assert.ok(
      problems[0]!.includes(`incluye ${host}, una IP fija de infraestructura`),
      problems[0],
    );
  }
});

test('validateProfileRanges: no puede dejar fuera del rango de su perfil la IP de un dispositivo existente', () => {
  const r = ranges({ internet_lan_full: ['192.168.10.75', '192.168.10.99'] });
  const ok = validateProfileRanges(r, {
    ...CTX,
    devices: [
      { username: 'vpn-diego-portatil', profile: 'internet_lan_full', ip: '192.168.10.77' },
    ],
  });
  assert.deepEqual(ok, []);

  const shrunk = ranges({ internet_lan_full: ['192.168.10.80', '192.168.10.99'] });
  const bad = validateProfileRanges(shrunk, {
    ...CTX,
    devices: [
      { username: 'vpn-diego-portatil', profile: 'internet_lan_full', ip: '192.168.10.77' },
    ],
  });
  assert.match(bad[0]!, /vpn-diego-portatil.*192\.168\.10\.77.*fuera del rango/);

  // perfil con dispositivos pero sin rango: tambien falla
  const noRange = validateProfileRanges(emptyRanges(), {
    ...CTX,
    devices: [
      { username: 'vpn-diego-portatil', profile: 'internet_lan_full', ip: '192.168.10.77' },
    ],
  });
  assert.equal(noRange.length, 1);
});

/* ------------------------------- pickFreeIpInRange ------------------------------ */

test('pickFreeIpInRange: primera IP libre, salta ocupadas y huecos', () => {
  assert.equal(pickFreeIpInRange('192.168.10.100', '192.168.10.109', []), '192.168.10.100');
  assert.equal(
    pickFreeIpInRange('192.168.10.100', '192.168.10.109', ['192.168.10.100', '192.168.10.101']),
    '192.168.10.102',
  );
  assert.equal(
    pickFreeIpInRange('192.168.10.100', '192.168.10.102', ['192.168.10.100', '192.168.10.102']),
    '192.168.10.101',
  );
});

test('pickFreeIpInRange: rango lleno devuelve null y nunca sale del rango', () => {
  // La .110 esta libre pero fuera del rango: no se asigna.
  assert.equal(
    pickFreeIpInRange('192.168.10.100', '192.168.10.101', ['192.168.10.100', '192.168.10.101']),
    null,
  );
  assert.equal(pickFreeIpInRange('192.168.10.100', '192.168.10.100', ['192.168.10.100']), null);
});

test('pickFreeIpInRange: IPs ocupadas de otros rangos no afectan', () => {
  assert.equal(
    pickFreeIpInRange('192.168.10.100', '192.168.10.101', ['192.168.10.50', '192.168.10.99']),
    '192.168.10.100',
  );
});

/* ------------------------- getProfileRanges / setProfileRanges ------------------ */

interface RangeRow {
  profile: string;
  range_start: string | null;
  range_end: string | null;
}

function mockPanelDb(opts: {
  rangeRows?: RangeRow[];
  deviceRows?: { username: string; access_profile: string; framed_ip: string }[];
  missingRangesTable?: boolean;
}) {
  const writes: { sql: string; params: Record<string, unknown> }[] = [];
  mock.method(pools.panelPool, 'query', (async (sql: string, params?: unknown) => {
    if (sql.includes('FROM panel_vpn_profile_ranges')) {
      if (opts.missingRangesTable) {
        const err = new Error('sin tabla') as Error & { code: string };
        err.code = 'ER_NO_SUCH_TABLE';
        throw err;
      }
      return [opts.rangeRows ?? [], []];
    }
    if (sql.includes('FROM panel_vpn_settings')) {
      const err = new Error('sin tabla') as Error & { code: string };
      err.code = 'ER_NO_SUCH_TABLE'; // getVpnSettings usa lanCidr por defecto 192.168.10.0/24
      throw err;
    }
    if (sql.includes('FROM panel_vpn_devices')) return [opts.deviceRows ?? [], []];
    if (sql.startsWith('INSERT INTO panel_vpn_profile_ranges')) {
      writes.push({ sql, params: params as Record<string, unknown> });
      return [{}, []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);
  return writes;
}

test('getProfileRanges: sin la tabla (migracion sin aplicar) devuelve todos los perfiles sin rango', async () => {
  mockPanelDb({ missingRangesTable: true });
  try {
    assert.deepEqual(await getProfileRanges(), emptyRanges());
  } finally {
    mock.restoreAll();
  }
});

test('requireProfileRange: perfil sin rango configurado -> error claro (409)', async () => {
  mockPanelDb({ rangeRows: [{ profile: 'internet_only', range_start: null, range_end: null }] });
  try {
    await assert.rejects(
      requireProfileRange('internet_only'),
      (err: Error & { status?: number }) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /internet_only no tiene rango/);
        return true;
      },
    );
  } finally {
    mock.restoreAll();
  }
});

test('setProfileRanges: rango valido -> guarda los 5 perfiles y devuelve antes/despues', async () => {
  const writes = mockPanelDb({
    rangeRows: [
      { profile: 'internet_lan_full', range_start: '192.168.10.75', range_end: '192.168.10.99' },
    ],
    deviceRows: [
      { username: 'vpn-vps', access_profile: 'internet_lan_full', framed_ip: '192.168.10.77' },
    ],
  });
  try {
    const next = ranges({
      internet_lan_full: ['192.168.10.75', '192.168.10.99'],
      internet_only: ['192.168.10.100', '192.168.10.109'],
    });
    const { before, after } = await setProfileRanges(next, 7);
    assert.deepEqual(before.internet_lan_full, {
      rangeStart: '192.168.10.75',
      rangeEnd: '192.168.10.99',
    });
    assert.deepEqual(before.internet_only, { rangeStart: null, rangeEnd: null });
    assert.deepEqual(after.internet_only, {
      rangeStart: '192.168.10.100',
      rangeEnd: '192.168.10.109',
    });
    assert.equal(writes.length, ACCESS_PROFILES.length);
    assert.ok(writes.every((w) => w.params.by === 7));
  } finally {
    mock.restoreAll();
  }
});

test('setProfileRanges: un solape se rechaza (400) sin escribir nada', async () => {
  const writes = mockPanelDb({});
  try {
    const next = ranges({
      internet_only: ['192.168.10.100', '192.168.10.110'],
      lan_full: ['192.168.10.105', '192.168.10.120'],
    });
    await assert.rejects(setProfileRanges(next, 1), (err: Error & { status?: number }) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /se solapan/);
      return true;
    });
    assert.equal(writes.length, 0);
  } finally {
    mock.restoreAll();
  }
});

test('setProfileRanges: un rango fuera de la LAN se rechaza sin escribir nada', async () => {
  const writes = mockPanelDb({});
  try {
    await assert.rejects(
      setProfileRanges(ranges({ internet_only: ['10.1.1.1', '10.1.1.9'] }), 1),
      /dentro de 192\.168\.10\.0\/24/,
    );
    assert.equal(writes.length, 0);
  } finally {
    mock.restoreAll();
  }
});

test('setProfileRanges: no deja un dispositivo existente fuera del rango de su perfil', async () => {
  const writes = mockPanelDb({
    deviceRows: [
      { username: 'vpn-vps', access_profile: 'internet_lan_full', framed_ip: '192.168.10.77' },
    ],
  });
  try {
    await assert.rejects(
      setProfileRanges(ranges({ internet_lan_full: ['192.168.10.80', '192.168.10.99'] }), 1),
      /vpn-vps.*fuera del rango/,
    );
    assert.equal(writes.length, 0);
  } finally {
    mock.restoreAll();
  }
});
