import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { sha256 } from '../lib/crypto.js';
import { generateGatewayToken, hasGatewayToken, verifyGatewayToken } from './vpnGatewayToken.js';

function setUpMockDb() {
  const state = { hash: null as string | null };

  mock.method(pools.panelPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.startsWith('SELECT gateway_token_sha256')) {
      return [[{ gateway_token_sha256: state.hash }], []];
    }
    if (sql.startsWith('UPDATE panel_vpn_settings SET gateway_token_sha256')) {
      state.hash = String(p.hash);
      return [{}, []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  return state;
}

test('generateGatewayToken/verifyGatewayToken: ida y vuelta', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const token = await generateGatewayToken();
  assert.equal(await verifyGatewayToken(token), true);
  assert.equal(await verifyGatewayToken('token-equivocado'), false);
});

test('generateGatewayToken: dos generaciones dan tokens distintos e invalidan el anterior', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  const first = await generateGatewayToken();
  const second = await generateGatewayToken();
  assert.notEqual(first, second);
  assert.equal(await verifyGatewayToken(first), false);
  assert.equal(await verifyGatewayToken(second), true);
});

test('hasGatewayToken: false hasta que se genera uno', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());

  assert.equal(await hasGatewayToken(), false);
  await generateGatewayToken();
  assert.equal(await hasGatewayToken(), true);
});

test('verifyGatewayToken: false si nunca se genero ninguno', async (t) => {
  setUpMockDb();
  t.after(() => mock.restoreAll());
  assert.equal(await verifyGatewayToken('cualquier-cosa'), false);
});

test('el hash guardado nunca es el token en claro', async (t) => {
  const state = setUpMockDb();
  t.after(() => mock.restoreAll());

  const token = await generateGatewayToken();
  assert.notEqual(state.hash, token);
  assert.equal(state.hash, sha256(token));
});
