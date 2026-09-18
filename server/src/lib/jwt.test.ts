import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-para-jwt';

test('signToken / verifyToken: ida y vuelta', async () => {
  const { signToken, verifyToken } = await import('./jwt.js');
  const token = signToken({ sub: 7, username: 'admin', role: 'admin' });
  const payload = verifyToken(token);
  assert.equal(payload.sub, 7);
  assert.equal(payload.username, 'admin');
  assert.equal(payload.role, 'admin');
});

test('verifyToken: rechaza un token manipulado', async () => {
  const { verifyToken } = await import('./jwt.js');
  assert.throws(() => verifyToken('no.es.un.jwt'));
});
