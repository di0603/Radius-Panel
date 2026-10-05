import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import {
  addRestrictedDestination,
  deleteRestrictedDestination,
  normalizePorts,
  updateRestrictedDestination,
  validateRestrictedEntry,
} from './vpnRestrictedList.js';

/**
 * Lista restringida: validacion estricta de cada campo (nada de texto libre
 * puede acabar en una regla nft) y CRUD con la base simulada.
 */

const LAN = '192.168.10.0/24';

function rejectsWith(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (err: Error & { status?: number }) => {
    assert.equal(err.status, 400);
    assert.match(err.message, pattern);
    return true;
  });
}

test('validateRestrictedEntry: IP suelta, CIDR canonico y puertos normalizados', () => {
  assert.deepEqual(
    validateRestrictedEntry(
      { destCidr: '192.168.10.50', protocol: 'tcp', ports: ' 22, 443,8000-8100 ' },
      LAN,
    ),
    {
      destCidr: '192.168.10.50',
      protocol: 'tcp',
      ports: '22,443,8000-8100',
      comment: '',
    },
  );
  assert.deepEqual(
    validateRestrictedEntry(
      { destCidr: '192.168.10.0/28', protocol: 'udp', ports: '53', comment: ' DNS interno ' },
      LAN,
    ),
    { destCidr: '192.168.10.0/28', protocol: 'udp', ports: '53', comment: 'DNS interno' },
  );
});

test('validateRestrictedEntry: tcp/udp sin puertos = todos; icmp sin puertos', () => {
  assert.equal(
    validateRestrictedEntry({ destCidr: '192.168.10.9', protocol: 'tcp' }, LAN).ports,
    null,
  );
  assert.equal(
    validateRestrictedEntry({ destCidr: '192.168.10.9', protocol: 'icmp', ports: '' }, LAN).ports,
    null,
  );
});

test('validateRestrictedEntry: icmp con puertos se rechaza', () => {
  rejectsWith(
    () => validateRestrictedEntry({ destCidr: '192.168.10.9', protocol: 'icmp', ports: '8' }, LAN),
    /icmp no admite puertos/,
  );
});

test('validateRestrictedEntry: destinos invalidos (texto libre, inyeccion, formato)', () => {
  const bad = [
    '',
    'google.com',
    '192.168.10.5; flush ruleset',
    '192.168.10.5 accept',
    '192.168.10.5\n192.168.10.6',
    '192.168.10.999',
    '192.168.10.5/33',
    '192.168.10.5/',
    '192.168.010.5',
    '{ 192.168.10.5 }',
    '$(reboot)',
  ];
  for (const destCidr of bad) {
    assert.throws(
      () => validateRestrictedEntry({ destCidr, protocol: 'tcp' }, LAN),
      (err: Error & { status?: number }) => err.status === 400,
      JSON.stringify(destCidr),
    );
  }
});

test('validateRestrictedEntry: CIDR con bits de host se rechaza (forma canonica)', () => {
  rejectsWith(
    () => validateRestrictedEntry({ destCidr: '192.168.10.5/24', protocol: 'tcp' }, LAN),
    /bits de host/,
  );
});

test('validateRestrictedEntry: el destino tiene que estar dentro de la LAN (la lista no abre Internet)', () => {
  rejectsWith(
    () => validateRestrictedEntry({ destCidr: '8.8.8.8', protocol: 'udp', ports: '53' }, LAN),
    /dentro de la LAN/,
  );
  rejectsWith(
    () => validateRestrictedEntry({ destCidr: '192.168.0.0/16', protocol: 'tcp' }, LAN),
    /dentro de la LAN/,
  );
  rejectsWith(
    () => validateRestrictedEntry({ destCidr: '10.0.0.1', protocol: 'tcp' }, LAN),
    /dentro de la LAN/,
  );
});

test('validateRestrictedEntry: protocolo fuera de tcp/udp/icmp', () => {
  rejectsWith(
    () => validateRestrictedEntry({ destCidr: '192.168.10.5', protocol: 'any' as never }, LAN),
    /tcp, udp o icmp/,
  );
});

test('validateRestrictedEntry: comentario con saltos de linea o demasiado largo', () => {
  rejectsWith(
    () =>
      validateRestrictedEntry(
        { destCidr: '192.168.10.5', protocol: 'tcp', comment: 'ok\naccept' },
        LAN,
      ),
    /caracteres de control/,
  );
  rejectsWith(
    () =>
      validateRestrictedEntry(
        { destCidr: '192.168.10.5', protocol: 'tcp', comment: 'x'.repeat(129) },
        LAN,
      ),
    /128 caracteres/,
  );
});

test('normalizePorts: puertos y rangos validos', () => {
  assert.equal(normalizePorts('22'), '22');
  assert.equal(normalizePorts('80 , 443'), '80,443');
  assert.equal(normalizePorts('8000-8100'), '8000-8100');
  assert.equal(normalizePorts('5-5'), '5');
  assert.equal(normalizePorts('1-65535'), '1-65535');
});

test('normalizePorts: rechaza todo lo que no sea numero o rango', () => {
  for (const bad of [
    '',
    '0',
    '65536',
    'ssh',
    '22;',
    '22 443',
    '10-5',
    '1-2-3',
    '-5',
    '22,',
    '{22}',
    '22 accept',
    '1e3',
  ]) {
    assert.throws(
      () => normalizePorts(bad),
      (err: Error & { status?: number }) => err.status === 400,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => normalizePorts(Array.from({ length: 17 }, (_, i) => String(i + 1)).join(',')),
    /Demasiados puertos/,
  );
});

/* ---------------------------------- CRUD (mocks) -------------------------------- */

interface Row {
  id: number;
  dest_cidr: string;
  protocol: string;
  ports: string | null;
  comment: string;
}

function mockDb(initial: Row[] = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  let nextId = Math.max(0, ...initial.map((r) => r.id)) + 1;
  mock.method(pools.panelPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes('FROM panel_vpn_settings')) {
      const err = new Error('sin tabla') as Error & { code: string };
      err.code = 'ER_NO_SUCH_TABLE';
      throw err;
    }
    if (
      sql.trimStart().startsWith('SELECT') &&
      sql.includes('FROM panel_vpn_restricted_destinations')
    )
      return [[...rows.values()], []];
    if (sql.startsWith('INSERT INTO panel_vpn_restricted_destinations')) {
      const id = nextId++;
      rows.set(id, {
        id,
        dest_cidr: String(p.destCidr),
        protocol: String(p.protocol),
        ports: (p.ports as string | null) ?? null,
        comment: String(p.comment),
      });
      return [{ insertId: id }, []];
    }
    if (sql.startsWith('UPDATE panel_vpn_restricted_destinations')) {
      rows.set(Number(p.id), {
        id: Number(p.id),
        dest_cidr: String(p.destCidr),
        protocol: String(p.protocol),
        ports: (p.ports as string | null) ?? null,
        comment: String(p.comment),
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('DELETE FROM panel_vpn_restricted_destinations')) {
      rows.delete(Number(p.id));
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);
  return rows;
}

test('addRestrictedDestination: guarda la entrada normalizada y rechaza duplicados', async () => {
  const rows = mockDb();
  try {
    const entry = await addRestrictedDestination(
      { destCidr: '192.168.10.50', protocol: 'tcp', ports: '443, 22' },
      3,
    );
    assert.equal(entry.ports, '443,22');
    assert.equal(rows.size, 1);
    await assert.rejects(
      addRestrictedDestination({ destCidr: '192.168.10.50', protocol: 'tcp', ports: '443,22' }, 3),
      (err: Error & { status?: number }) => err.status === 409,
    );
    assert.equal(rows.size, 1);
  } finally {
    mock.restoreAll();
  }
});

test('addRestrictedDestination: una entrada invalida no escribe nada', async () => {
  const rows = mockDb();
  try {
    await assert.rejects(
      addRestrictedDestination({ destCidr: '1.1.1.1', protocol: 'tcp' }, 3),
      /dentro de la LAN/,
    );
    assert.equal(rows.size, 0);
  } finally {
    mock.restoreAll();
  }
});

test('updateRestrictedDestination: devuelve antes/despues (para la auditoria) y 404 si no existe', async () => {
  mockDb([{ id: 1, dest_cidr: '192.168.10.50', protocol: 'tcp', ports: '22', comment: 'ssh' }]);
  try {
    const { before, after } = await updateRestrictedDestination(1, {
      destCidr: '192.168.10.50',
      protocol: 'tcp',
      ports: '22,2222',
      comment: 'ssh',
    });
    assert.equal(before.ports, '22');
    assert.equal(after.ports, '22,2222');
    await assert.rejects(
      updateRestrictedDestination(99, { destCidr: '192.168.10.50', protocol: 'tcp' }),
      (err: Error & { status?: number }) => err.status === 404,
    );
  } finally {
    mock.restoreAll();
  }
});

test('deleteRestrictedDestination: devuelve la entrada borrada y 404 si no existe', async () => {
  const rows = mockDb([
    { id: 1, dest_cidr: '192.168.10.50', protocol: 'icmp', ports: null, comment: '' },
  ]);
  try {
    const before = await deleteRestrictedDestination(1);
    assert.equal(before.protocol, 'icmp');
    assert.equal(rows.size, 0);
    await assert.rejects(
      deleteRestrictedDestination(1),
      (err: Error & { status?: number }) => err.status === 404,
    );
  } finally {
    mock.restoreAll();
  }
});
