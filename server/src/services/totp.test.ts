import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecret, generateSync } from 'otplib';
import { encryptSecret } from '../lib/crypto.js';
import { verifyTotpCode } from './auth.js';

test('verifyTotpCode: acepta el codigo actual del secreto', async () => {
  const secret = generateSecret();
  const code = generateSync({ secret });
  assert.equal(await verifyTotpCode(encryptSecret(secret), code), true);
});

test('verifyTotpCode: tolera espacios al pegar el codigo', async () => {
  const secret = generateSecret();
  const code = generateSync({ secret });
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  assert.equal(await verifyTotpCode(encryptSecret(secret), spaced), true);
});

test('verifyTotpCode: rechaza un codigo que no toca', async () => {
  const secret = generateSecret();
  const code = generateSync({ secret });
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal(await verifyTotpCode(encryptSecret(secret), wrong), false);
});

test('verifyTotpCode: rechaza el codigo de otro secreto', async () => {
  const code = generateSync({ secret: generateSecret() });
  assert.equal(await verifyTotpCode(encryptSecret(generateSecret()), code), false);
});

test('verifyTotpCode: no revienta si el secreto guardado esta corrupto', async () => {
  assert.equal(await verifyTotpCode('esto-no-es-un-secreto', '123456'), false);
});
