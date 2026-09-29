import assert from 'node:assert/strict';
import test from 'node:test';
import { formatFingerprint } from './fingerprint.js';

const SHA256_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff';

test('formatFingerprint: agrupa de 4 en 4, en mayusculas, separado por espacios', () => {
  const result = formatFingerprint(SHA256_HEX);
  assert.equal(
    result.full,
    'A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90 1122 3344 5566 7788 99AA BBCC DDEE FF',
  );
});

test('formatFingerprint: el codigo corto es exactamente los primeros 8 grupos (32 caracteres)', () => {
  const result = formatFingerprint(SHA256_HEX);
  assert.equal(result.short, 'A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90');
  assert.equal(result.short.replace(/ /g, '').length, 32);
});

test('formatFingerprint: el "full" contiene los 64 caracteres hex originales, solo reformateados', () => {
  const result = formatFingerprint(SHA256_HEX);
  assert.equal(result.full.replace(/ /g, '').toLowerCase(), SHA256_HEX);
});

test('formatFingerprint: es insensible a mayusculas/minusculas de entrada', () => {
  assert.deepEqual(formatFingerprint(SHA256_HEX), formatFingerprint(SHA256_HEX.toUpperCase()));
});
