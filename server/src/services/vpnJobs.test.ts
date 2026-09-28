import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as pools from '../db/pools.js';
import { config } from '../config.js';
import { encryptPkiPrivateKey } from '../lib/pkiCrypto.js';
import { EC_P384_SIGNING_ALGORITHM, exportPrivateKeyPem, generateEcKeyPair, x509 } from '../lib/x509.js';
import { runVpnJobs } from './vpnJobs.js';

/**
 * `runVpnJobs` es lo que dispara `npm run vpn:jobs` cada 15 min en
 * produccion: certificados superseded cuya ventana ya paso pasan a
 * revoked (+ CRL), los revocados recien caducados se podan de la CRL, los
 * tokens de alta caducados se borran, y se regenera la CRL si le queda
 * poco. Todo bajo un bloqueo de MySQL para que dos ejecuciones simultaneas
 * no se pisen.
 */

config.pki.masterKey = 'j'.repeat(32);

const DAY = 24 * 60 * 60 * 1000;
const CA_ID = 1;

async function makeChain() {
  const rootKeys = await generateEcKeyPair('P-384');
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root',
    keys: rootKeys,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 3650 * DAY),
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
  });
  const interKeys = await generateEcKeyPair('P-384');
  const intermediate = await x509.X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate',
    issuer: root.subject,
    publicKey: interKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: EC_P384_SIGNING_ALGORITHM,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
  });
  return { root, intermediate, interKeys };
}

const { root, intermediate, interKeys } = await makeChain();
const interKeyPem = await exportPrivateKeyPem(interKeys.privateKey);

function toSqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

interface CertRow {
  serial: string;
  ca_id: number | null;
  status: string;
  superseded_until: string | null;
  not_after: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

interface FakeState {
  caRow: {
    id: number;
    status: string;
    cert_pem: string;
    root_cert_pem: string;
    private_key_encrypted: string;
    crl_pem: string | null;
    crl_number: number;
    crl_next_update: string | null;
  };
  certificates: Map<string, CertRow>;
  tokens: Map<number, { id: number; expires_at: string }>;
  lockHeld: boolean;
}

function makeState(overrides: { crlNextUpdate?: Date | null } = {}): FakeState {
  return {
    caRow: {
      id: CA_ID,
      status: 'active',
      cert_pem: intermediate.toString(),
      root_cert_pem: root.toString(),
      private_key_encrypted: encryptPkiPrivateKey(interKeyPem),
      crl_pem: null,
      crl_number: 0,
      crl_next_update:
        overrides.crlNextUpdate === null
          ? null
          : toSqlDateTime(overrides.crlNextUpdate ?? new Date(Date.now() + 7 * DAY)),
    },
    certificates: new Map(),
    tokens: new Map(),
    lockHeld: false,
  };
}

function setUpMockDb(state: FakeState) {
  const fakeConn = {
    async query(sql: string, params?: unknown) {
      const p = (params ?? {}) as Record<string, unknown>;
      if (sql.includes('GET_LOCK')) {
        if (state.lockHeld) return [[{ locked: 0 }], []];
        state.lockHeld = true;
        return [[{ locked: 1 }], []];
      }
      if (sql.includes('RELEASE_LOCK')) {
        state.lockHeld = false;
        return [[{ released: 1 }], []];
      }
      throw new Error(`fakeConn.query no esperado: ${sql} ${JSON.stringify(p)}`);
    },
    release() {},
  };
  mock.method(pools.panelPool, 'getConnection', (async () => fakeConn) as never);

  mock.method(pools.panelPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.startsWith('SELECT * FROM panel_pki_ca WHERE id')) {
      return [[state.caRow], []];
    }
    if (sql.startsWith('UPDATE panel_pki_ca SET crl_pem')) {
      state.caRow.crl_pem = String(p.crlPem);
      state.caRow.crl_number += 1;
      state.caRow.crl_next_update = toSqlDateTime(p.nextUpdate as Date);
      return [{}, []];
    }
    if (sql.includes('FROM panel_pki_ca') && sql.includes('crl_next_update')) {
      const due =
        !state.caRow.crl_next_update ||
        Date.parse(`${state.caRow.crl_next_update.replace(' ', 'T')}Z`) <=
          Date.now() + Number(p.withinDays) * DAY;
      const isRelevantStatus = state.caRow.status === 'active' || state.caRow.status === 'retiring';
      return [isRelevantStatus && due ? [{ id: state.caRow.id }] : [], []];
    }
    if (sql.startsWith('DELETE FROM panel_vpn_enroll_tokens')) {
      const now = Date.now();
      let removed = 0;
      for (const [id, tok] of state.tokens) {
        if (Date.parse(`${tok.expires_at.replace(' ', 'T')}Z`) < now) {
          state.tokens.delete(id);
          removed++;
        }
      }
      return [{ affectedRows: removed }, []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  mock.method(pools.radiusPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes("status = 'superseded'") && sql.includes('superseded_until <')) {
      const rows = [...state.certificates.values()].filter(
        (c) => c.status === 'superseded' && c.superseded_until && c.superseded_until < toSqlDateTime(new Date()),
      );
      return [rows.map((r) => ({ serial: r.serial, ca_id: r.ca_id })), []];
    }
    if (sql.includes("SET status = 'revoked'") && sql.includes("revoke_reason = 'superseded'")) {
      const row = state.certificates.get(String(p.serial));
      if (row) {
        row.status = 'revoked';
        row.revoked_at = toSqlDateTime(new Date());
        row.revoke_reason = 'superseded';
      }
      return [{}, []];
    }
    if (sql.includes('SELECT DISTINCT ca_id')) {
      const minutes = Number(p.minutes);
      const now = Date.now();
      const ids = new Set(
        [...state.certificates.values()]
          .filter((c) => {
            if (c.status !== 'revoked' || c.ca_id == null) return false;
            const notAfter = Date.parse(`${c.not_after.replace(' ', 'T')}Z`);
            return notAfter <= now && notAfter >= now - minutes * 60_000;
          })
          .map((c) => c.ca_id),
      );
      return [[...ids].map((id) => ({ ca_id: id })), []];
    }
    if (sql.startsWith('SELECT serial, revoked_at FROM vpn_certificates')) {
      const rows = [...state.certificates.values()].filter(
        (c) =>
          c.ca_id === Number(p.caId) &&
          c.status === 'revoked' &&
          Date.parse(`${c.not_after.replace(' ', 'T')}Z`) > Date.now(),
      );
      return [rows.map((r) => ({ serial: r.serial, revoked_at: r.revoked_at })), []];
    }
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);
}

test('runVpnJobs: pasa a revoked los superseded cuya ventana ya paso y regenera su CRL', async (t) => {
  const state = makeState();
  state.certificates.set('aaaa', {
    serial: 'aaaa',
    ca_id: CA_ID,
    status: 'superseded',
    superseded_until: toSqlDateTime(new Date(Date.now() - 60_000)),
    not_after: toSqlDateTime(new Date(Date.now() + 30 * DAY)),
    revoked_at: null,
    revoke_reason: null,
  });
  setUpMockDb(state);
  t.after(() => mock.restoreAll());

  const summary = await runVpnJobs();
  assert.equal(summary?.supersededToRevoked, 1);
  const cert = state.certificates.get('aaaa')!;
  assert.equal(cert.status, 'revoked');
  assert.equal(cert.revoke_reason, 'superseded');
  assert.ok(state.caRow.crl_pem, 'la CRL deberia haberse regenerado');
});

test('runVpnJobs: no toca un superseded cuya ventana de solapamiento no ha pasado todavia', async (t) => {
  const state = makeState();
  state.certificates.set('bbbb', {
    serial: 'bbbb',
    ca_id: CA_ID,
    status: 'superseded',
    superseded_until: toSqlDateTime(new Date(Date.now() + 60_000)),
    not_after: toSqlDateTime(new Date(Date.now() + 30 * DAY)),
    revoked_at: null,
    revoke_reason: null,
  });
  setUpMockDb(state);
  t.after(() => mock.restoreAll());

  const summary = await runVpnJobs();
  assert.equal(summary?.supersededToRevoked, 0);
  assert.equal(state.certificates.get('bbbb')!.status, 'superseded');
});

test('runVpnJobs: poda de la CRL un revocado que acaba de caducar, no uno caducado hace tiempo', async (t) => {
  const state = makeState({ crlNextUpdate: new Date(Date.now() + 7 * DAY) }); // no toca por el ciclo normal
  state.certificates.set('recent', {
    serial: 'recent',
    ca_id: CA_ID,
    status: 'revoked',
    superseded_until: null,
    not_after: toSqlDateTime(new Date(Date.now() - 5 * 60_000)), // caduco hace 5 min
    revoked_at: toSqlDateTime(new Date(Date.now() - 10 * DAY)),
    revoke_reason: 'compromised',
  });
  state.certificates.set('old', {
    serial: 'old',
    ca_id: CA_ID,
    status: 'revoked',
    superseded_until: null,
    not_after: toSqlDateTime(new Date(Date.now() - 60 * DAY)), // caduco hace mucho
    revoked_at: toSqlDateTime(new Date(Date.now() - 90 * DAY)),
    revoke_reason: 'compromised',
  });
  setUpMockDb(state);
  t.after(() => mock.restoreAll());

  const summary = await runVpnJobs();
  assert.equal(summary?.crlsPrunedNow, 1);
  assert.ok(state.caRow.crl_pem, 'la CRL deberia haberse regenerado para podar "recent"');
});

test('runVpnJobs: borra los tokens de alta caducados, deja los vigentes', async (t) => {
  const state = makeState();
  state.tokens.set(1, { id: 1, expires_at: toSqlDateTime(new Date(Date.now() - 60_000)) });
  state.tokens.set(2, { id: 2, expires_at: toSqlDateTime(new Date(Date.now() + DAY)) });
  setUpMockDb(state);
  t.after(() => mock.restoreAll());

  const summary = await runVpnJobs();
  assert.equal(summary?.expiredTokensDeleted, 1);
  assert.deepEqual([...state.tokens.keys()], [2]);
});

test('runVpnJobs: regenera la CRL si vence dentro de 3 dias, aunque ya tenga una valida', async (t) => {
  const state = makeState({ crlNextUpdate: new Date(Date.now() + 2 * DAY) });
  setUpMockDb(state);
  t.after(() => mock.restoreAll());

  const summary = await runVpnJobs();
  assert.equal(summary?.crlsRegenerated, 1);
  assert.ok(state.caRow.crl_pem);
});

test('runVpnJobs: no regenera si a la CRL le quedan mas de 3 dias y no hay nada que podar', async (t) => {
  const state = makeState({ crlNextUpdate: new Date(Date.now() + 6 * DAY) });
  setUpMockDb(state);
  t.after(() => mock.restoreAll());

  const summary = await runVpnJobs();
  assert.equal(summary?.crlsRegenerated, 0);
  assert.equal(summary?.crlsPrunedNow, 0);
  assert.equal(state.caRow.crl_pem, null);
});

test('runVpnJobs: si ya hay otra ejecucion en marcha (bloqueo tomado), se omite sin hacer nada', async (t) => {
  const state = makeState();
  state.lockHeld = true; // simula que otro proceso ya tiene el GET_LOCK
  setUpMockDb(state);
  t.after(() => mock.restoreAll());

  const summary = await runVpnJobs();
  assert.equal(summary, null);
});
