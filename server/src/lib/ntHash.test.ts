import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ntPasswordHash } from './ntHash.js';

test('ntPasswordHash: vectores conocidos', () => {
  assert.equal(ntPasswordHash(''), '31D6CFE0D16AE931B73C59D7E0C089C0');
  assert.equal(ntPasswordHash('password'), '8846F7EAEE8FB117AD06BDD830B7586C');
  assert.equal(ntPasswordHash('abc'), 'E0FBA38268D0EC66EF1CB452D5885E53');
});

test('ntPasswordHash: siempre 32 hex mayusculas', () => {
  const h = ntPasswordHash('un-password-cualquiera-123');
  assert.match(h, /^[0-9A-F]{32}$/);
});
