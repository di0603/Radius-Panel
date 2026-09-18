import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.js';

test('hashPassword / verifyPassword: ida y vuelta', async () => {
  const hash = await hashPassword('Sup3rSecreta!');
  assert.notEqual(hash, 'Sup3rSecreta!');
  assert.equal(await verifyPassword('Sup3rSecreta!', hash), true);
  assert.equal(await verifyPassword('otra', hash), false);
});
