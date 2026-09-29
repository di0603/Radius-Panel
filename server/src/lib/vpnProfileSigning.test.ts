import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { config } from '../config.js';
import {
  PROFILE_SIGNING_KEY_ID,
  getSignerPublicKeySha256Hex,
  getSignerPublicKeySpkiBase64Url,
  isProfileSigningConfigured,
  signProfilePayload,
} from './vpnProfileSigning.js';

function writeTempKey(): { keyPath: string; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'radius-panel-profile-key-'));
  const keyPath = join(dir, 'key.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  return { keyPath, publicKey };
}

test('isProfileSigningConfigured: refleja config.vpnProfileSigning.keyPath', () => {
  const prev = config.vpnProfileSigning.keyPath;
  try {
    config.vpnProfileSigning.keyPath = undefined;
    assert.equal(isProfileSigningConfigured(), false);
    config.vpnProfileSigning.keyPath = '/alguna/ruta.pem';
    assert.equal(isProfileSigningConfigured(), true);
  } finally {
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('signProfilePayload: sin VPN_PROFILE_SIGNING_KEY, lanza un error claro (no un fallo generico)', () => {
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = undefined;
  try {
    assert.throws(() => signProfilePayload({ a: 1 }), /VPN_PROFILE_SIGNING_KEY/);
  } finally {
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('signProfilePayload: firma Ed25519 verificable con la clave publica correspondiente', () => {
  const { keyPath, publicKey } = writeTempKey();
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;
  try {
    const envelope = signProfilePayload({ hola: 'mundo', n: 42 });
    assert.equal(envelope.keyId, PROFILE_SIGNING_KEY_ID);

    const payloadBytes = Buffer.from(envelope.payload, 'base64url');
    const signatureBytes = Buffer.from(envelope.signature, 'base64url');
    assert.equal(verify(null, payloadBytes, publicKey, signatureBytes), true);

    // signerPublicKey del sobre es la SPKI DER real de esta clave, tal cual
    // la exportaria node:crypto -es lo que la app aprende la primera vez
    // que ve este servidor (TOFU)-.
    assert.equal(envelope.signerPublicKey, publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'));
  } finally {
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('getSignerPublicKeySpkiBase64Url / getSignerPublicKeySha256Hex: coinciden con signerPublicKey del sobre', () => {
  const { keyPath, publicKey } = writeTempKey();
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;
  try {
    const envelope = signProfilePayload({ a: 1 });
    assert.equal(getSignerPublicKeySpkiBase64Url(), envelope.signerPublicKey);

    const expectedSha256 = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    assert.equal(getSignerPublicKeySha256Hex(), expectedSha256);
  } finally {
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('getSignerPublicKeySha256Hex: sin VPN_PROFILE_SIGNING_KEY, lanza el mismo error claro que signProfilePayload', () => {
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = undefined;
  try {
    assert.throws(() => getSignerPublicKeySha256Hex(), /VPN_PROFILE_SIGNING_KEY/);
  } finally {
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('signProfilePayload: "payload" es el base64 exacto de los bytes firmados, no una re-serializacion', () => {
  const { keyPath } = writeTempKey();
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;
  try {
    const obj = { z: 1, a: 2 }; // orden de claves deliberadamente "raro"
    const envelope = signProfilePayload(obj);
    const payloadBytes = Buffer.from(envelope.payload, 'base64url');
    // Verificar no debe requerir reproducir el mismo JSON.stringify: basta
    // con decodificar el base64 y usar esos bytes tal cual.
    assert.equal(payloadBytes.toString('utf8'), JSON.stringify(obj));
  } finally {
    config.vpnProfileSigning.keyPath = prev;
  }
});

test('signProfilePayload: una firma no vale para un payload distinto, ni con la clave publica de otra clave', () => {
  const { keyPath, publicKey } = writeTempKey();
  const other = writeTempKey();
  const prev = config.vpnProfileSigning.keyPath;
  config.vpnProfileSigning.keyPath = keyPath;
  try {
    const envelope = signProfilePayload({ a: 1 });
    const signatureBytes = Buffer.from(envelope.signature, 'base64url');

    const tamperedPayload = Buffer.from(JSON.stringify({ a: 2 }), 'utf8');
    assert.equal(verify(null, tamperedPayload, publicKey, signatureBytes), false);

    const originalPayload = Buffer.from(envelope.payload, 'base64url');
    assert.equal(verify(null, originalPayload, other.publicKey, signatureBytes), false);
  } finally {
    config.vpnProfileSigning.keyPath = prev;
  }
});
