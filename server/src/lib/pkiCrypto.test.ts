import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptWithMasterKey, encryptWithMasterKey } from './pkiCrypto.js';

const MASTER_KEY = 'x'.repeat(32);

test('encryptWithMasterKey/decryptWithMasterKey: ida y vuelta', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIExampleNotARealKey==\n-----END PRIVATE KEY-----';
  const boxed = encryptWithMasterKey(MASTER_KEY, pem);
  assert.notEqual(boxed, pem, 'la clave privada no puede quedar en claro');
  assert.equal(decryptWithMasterKey(MASTER_KEY, boxed), pem);
});

test('encryptWithMasterKey: dos cifrados del mismo valor son distintos (IV aleatorio)', () => {
  assert.notEqual(
    encryptWithMasterKey(MASTER_KEY, 'misma-clave'),
    encryptWithMasterKey(MASTER_KEY, 'misma-clave'),
  );
});

test('decryptWithMasterKey: rechaza un payload manipulado', () => {
  const boxed = encryptWithMasterKey(MASTER_KEY, 'secreto');
  const [iv, tag] = boxed.split('.');
  const tampered = [iv, tag, Buffer.from('otracosa').toString('base64url')].join('.');
  assert.throws(() => decryptWithMasterKey(MASTER_KEY, tampered));
});

test('decryptWithMasterKey: rechaza una master key distinta a la de cifrado', () => {
  const boxed = encryptWithMasterKey(MASTER_KEY, 'secreto');
  assert.throws(() => decryptWithMasterKey('y'.repeat(32), boxed));
});
