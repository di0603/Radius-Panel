import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256 } from './crypto.js';

test('encryptSecret/decryptSecret: ida y vuelta', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const boxed = encryptSecret(secret);
  assert.notEqual(boxed, secret, 'el secreto no puede quedar en claro');
  assert.equal(decryptSecret(boxed), secret);
});

test('encryptSecret: dos cifrados del mismo valor son distintos (IV aleatorio)', () => {
  assert.notEqual(encryptSecret('mismo'), encryptSecret('mismo'));
});

test('decryptSecret: rechaza un payload manipulado', () => {
  const boxed = encryptSecret('secreto');
  const [iv, tag, data] = boxed.split('.');
  const tampered = [iv, tag, Buffer.from('otracosa').toString('base64url')].join('.');
  assert.throws(() => decryptSecret(tampered));
  assert.throws(() => decryptSecret('formato-invalido'), /formato invalido/);
  assert.equal(decryptSecret(`${iv}.${tag}.${data}`), 'secreto');
});

test('sha256: determinista y de 64 caracteres hex', () => {
  const hash = sha256('token');
  assert.equal(hash, sha256('token'));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, sha256('token2'));
});

test('randomToken: unico y sin caracteres problematicos en cookies', () => {
  const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
  assert.equal(tokens.size, 50);
  for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test('safeEqual: compara sin filtrar por longitud', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});
