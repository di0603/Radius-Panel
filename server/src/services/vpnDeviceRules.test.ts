import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { addDeviceRule, deleteDeviceRule, listDeviceRules } from './vpnDeviceRules.js';

interface RuleRow {
  id: number;
  username: string;
  kind: string;
  dest_cidr: string | null;
  protocol: string | null;
  port: number | null;
  created_at: string;
}

function setUpMockDb() {
  const rules = new Map<number, RuleRow>();
  let nextId = 1;

  mock.method(pools.panelPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.startsWith('SELECT username FROM panel_vpn_devices')) {
      return [p.u === 'vpn-juan-laptop' ? [{ username: 'vpn-juan-laptop' }] : [], []];
    }
    if (sql.startsWith('SELECT id, kind, dest_cidr, protocol, port, created_at\n         FROM panel_vpn_device_rules WHERE username')) {
      const rows = [...rules.values()].filter((r) => r.username === p.u).sort((a, b) => a.id - b.id);
      return [rows, []];
    }
    if (sql.startsWith('INSERT INTO panel_vpn_device_rules')) {
      const id = nextId++;
      rules.set(id, {
        id,
        username: String(p.u),
        kind: String(p.kind),
        dest_cidr: (p.destCidr as string | null) ?? null,
        protocol: (p.protocol as string | null) ?? null,
        port: (p.port as number | null) ?? null,
        created_at: '2026-01-01 00:00:00',
      });
      return [{ insertId: id }, []];
    }
    if (sql.startsWith('SELECT id, kind, dest_cidr, protocol, port, created_at FROM panel_vpn_device_rules WHERE id')) {
      const row = rules.get(Number(p.id));
      return [row ? [row] : [], []];
    }
    if (sql.startsWith('DELETE FROM panel_vpn_device_rules')) {
      const row = rules.get(Number(p.id));
      const matches = !!row && row.username === p.u;
      if (matches) rules.delete(Number(p.id));
      return [{ affectedRows: matches ? 1 : 0 }, []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  return { rules };
}

test('addDeviceRule: "internet" no necesita destino', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const rule = await addDeviceRule('vpn-juan-laptop', { kind: 'internet' }, null);
  assert.equal(rule.kind, 'internet');
  assert.equal(rule.destCidr, null);
});

test('addDeviceRule: "custom" exige un destCidr valido', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  await assert.rejects(
    addDeviceRule('vpn-juan-laptop', { kind: 'custom', destCidr: 'no-es-una-ip' }, null),
    /IPv4 o un CIDR/,
  );
  await assert.rejects(addDeviceRule('vpn-juan-laptop', { kind: 'custom' }, null), /IPv4 o un CIDR/);
});

test('addDeviceRule: "custom" con puerto exige protocolo tcp/udp', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  await assert.rejects(
    addDeviceRule('vpn-juan-laptop', { kind: 'custom', destCidr: '8.8.8.8', port: 53 }, null),
    /tcp o udp/,
  );
  await assert.rejects(
    addDeviceRule('vpn-juan-laptop', { kind: 'custom', destCidr: '8.8.8.8', protocol: 'any', port: 53 }, null),
    /tcp o udp/,
  );
});

test('addDeviceRule: "custom" con destino/protocolo/puerto validos', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const rule = await addDeviceRule(
    'vpn-juan-laptop',
    { kind: 'custom', destCidr: '8.8.8.8', protocol: 'udp', port: 53 },
    7,
  );
  assert.equal(rule.destCidr, '8.8.8.8');
  assert.equal(rule.protocol, 'udp');
  assert.equal(rule.port, 53);
});

test('addDeviceRule: rechaza un dispositivo desconocido', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());
  await assert.rejects(addDeviceRule('vpn-no-existe', { kind: 'internet' }, null), /No existe/);
});

test('listDeviceRules/deleteDeviceRule: listar y borrar solo del dispositivo correcto', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const r1 = await addDeviceRule('vpn-juan-laptop', { kind: 'internet' }, null);
  const list = await listDeviceRules('vpn-juan-laptop');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, r1.id);

  await deleteDeviceRule('vpn-juan-laptop', r1.id);
  assert.deepEqual(await listDeviceRules('vpn-juan-laptop'), []);
});

test('deleteDeviceRule: rechaza borrar un permiso que no existe (o de otro dispositivo)', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());
  await assert.rejects(deleteDeviceRule('vpn-juan-laptop', 999), /No existe/);
});
