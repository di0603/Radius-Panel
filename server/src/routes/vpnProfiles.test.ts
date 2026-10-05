import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import test, { after, before, beforeEach, mock } from 'node:test';
import * as pools from '../db/pools.js';
import { signToken } from '../lib/jwt.js';
import { errorHandler } from '../middleware/error.js';
import { vpnDevicesRouter } from './vpnDevices.js';
import { vpnProfilesRouter } from './vpnProfiles.js';

/**
 * Rutas de perfiles de acceso: solo admin, y cada cambio (perfil de un
 * dispositivo, rangos, lista restringida) deja una fila de auditoria con
 * quien, que y antes/despues. Se monta el router real en un express efimero y
 * se llama por HTTP; las dos bases son simuladas (no hay base, ni agenda, ni
 * nftables real de por medio).
 */

interface AuditRow {
  admin_id: number | null;
  admin_name: string;
  action: string;
  entity: string;
  entity_id: string;
  detail: unknown;
}

interface Db {
  audit: AuditRow[];
  ranges: Map<string, { range_start: string | null; range_end: string | null }>;
  destinations: Map<
    number,
    { id: number; dest_cidr: string; protocol: string; ports: string | null; comment: string }
  >;
  device: { username: string; access_profile: string; framed_ip: string | null };
  radreply: Map<string, string>;
  nextId: number;
}

let db: Db;
let server: Server;
let base: string;

const adminToken = signToken({ sub: 7, username: 'diego', role: 'admin' });
const operatorToken = signToken({ sub: 8, username: 'operador', role: 'operator' });

function freshDb(): Db {
  return {
    audit: [],
    ranges: new Map([
      ['internet_lan_full', { range_start: '192.168.10.75', range_end: '192.168.10.99' }],
    ]),
    destinations: new Map(),
    device: {
      username: 'vpn-diego-portatil',
      access_profile: 'internet_lan_full',
      framed_ip: '192.168.10.77',
    },
    radreply: new Map([['vpn-diego-portatil', '192.168.10.77']]),
    nextId: 1,
  };
}

function installMocks() {
  mock.method(pools.panelPool, 'query', (async (sql: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (sql.includes('INSERT INTO panel_audit_log')) {
      db.audit.push({
        admin_id: p.admin_id as number | null,
        admin_name: String(p.admin_name),
        action: String(p.action),
        entity: String(p.entity),
        entity_id: String(p.entity_id),
        detail: p.detail ? JSON.parse(String(p.detail)) : null,
      });
      return [{}, []];
    }
    if (sql.includes('FROM panel_vpn_settings')) {
      const err = new Error('sin tabla') as Error & { code: string };
      err.code = 'ER_NO_SUCH_TABLE'; // ajustes por defecto: lanCidr 192.168.10.0/24
      throw err;
    }
    if (sql.includes('FROM panel_vpn_profile_ranges')) {
      return [[...db.ranges.entries()].map(([profile, r]) => ({ profile, ...r })), []];
    }
    if (sql.startsWith('INSERT INTO panel_vpn_profile_ranges')) {
      db.ranges.set(String(p.profile), {
        range_start: (p.start as string) ?? null,
        range_end: (p.end as string) ?? null,
      });
      return [{}, []];
    }
    if (sql.startsWith('SELECT username, access_profile, framed_ip')) {
      return [[{ ...db.device }], []];
    }
    if (sql.startsWith('SELECT * FROM panel_vpn_devices WHERE username')) {
      return [
        [
          {
            id: 1,
            owner_user: 'diego',
            device_label: 'portatil',
            owner_name: null,
            platform: 'windows',
            tunnel_mode: 'full',
            enabled: 1,
            created_at: 'x',
            updated_at: 'x',
            ...db.device,
          },
        ],
        [],
      ];
    }
    if (sql.startsWith('UPDATE panel_vpn_devices SET access_profile')) {
      db.device = {
        username: String(p.u),
        access_profile: String(p.profile),
        framed_ip: String(p.ip),
      };
      return [{}, []];
    }
    if (
      sql.trimStart().startsWith('SELECT') &&
      sql.includes('FROM panel_vpn_restricted_destinations')
    ) {
      return [[...db.destinations.values()], []];
    }
    if (sql.startsWith('INSERT INTO panel_vpn_restricted_destinations')) {
      const id = db.nextId++;
      db.destinations.set(id, {
        id,
        dest_cidr: String(p.destCidr),
        protocol: String(p.protocol),
        ports: (p.ports as string) ?? null,
        comment: String(p.comment),
      });
      return [{ insertId: id }, []];
    }
    if (sql.startsWith('UPDATE panel_vpn_restricted_destinations')) {
      db.destinations.set(Number(p.id), {
        id: Number(p.id),
        dest_cidr: String(p.destCidr),
        protocol: String(p.protocol),
        ports: (p.ports as string) ?? null,
        comment: String(p.comment),
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('DELETE FROM panel_vpn_restricted_destinations')) {
      db.destinations.delete(Number(p.id));
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`panelPool.query no esperado: ${sql}`);
  }) as never);

  const conn = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql: string, params?: unknown) {
      const p = (params ?? {}) as Record<string, string>;
      if (sql.includes("SELECT value FROM radreply WHERE attribute = 'Framed-IP-Address'")) {
        return [[...db.radreply.values()].map((value) => ({ value })), []];
      }
      if (sql.startsWith('UPDATE radreply SET value')) {
        db.radreply.set(p.u!, p.ip!);
        return [{ affectedRows: 1 }, []];
      }
      return [{}, []];
    },
  };
  mock.method(pools.radiusPool, 'getConnection', (async () => conn) as never);
  // Sesiones activas del dispositivo para disconnectUserSessions: ninguna (no hay NAS ni UDP real).
  mock.method(pools.radiusPool, 'query', (async (sql: string) => {
    if (sql.includes('FROM radacct')) return [[], []];
    throw new Error(`radiusPool.query no esperado: ${sql}`);
  }) as never);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/vpn-profiles', vpnProfilesRouter);
  app.use('/api/vpn-devices', vpnDevicesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mock.restoreAll();
  db = freshDb();
  installMocks();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = adminToken,
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* no JSON (descarga .nft) */
  }
  return {
    status: res.status,
    json: json as Record<string, unknown> | null,
    text,
    headers: res.headers,
  };
}

/* --------------------------- solo admin / autenticacion -------------------------- */

test('todas las rutas de perfiles exigen sesion y rol admin', async () => {
  const requests: [string, string, unknown?][] = [
    ['GET', '/api/vpn-profiles'],
    ['PUT', '/api/vpn-profiles/ranges', { ranges: {} }],
    ['POST', '/api/vpn-profiles/destinations', { destCidr: '192.168.10.5', protocol: 'tcp' }],
    ['PUT', '/api/vpn-profiles/destinations/1', { destCidr: '192.168.10.5', protocol: 'tcp' }],
    ['DELETE', '/api/vpn-profiles/destinations/1'],
    ['GET', '/api/vpn-profiles/nft'],
    ['GET', '/api/vpn-profiles/nftables-fragment'],
    ['PATCH', '/api/vpn-devices/vpn-diego-portatil/access-profile', { accessProfile: 'lan_full' }],
  ];
  for (const [method, path, body] of requests) {
    assert.equal((await call(method, path, body, null)).status, 401, `${method} ${path} sin token`);
    assert.equal(
      (await call(method, path, body, operatorToken)).status,
      403,
      `${method} ${path} como operador`,
    );
  }
  assert.equal(db.audit.length, 0);
  assert.deepEqual(db.device, {
    username: 'vpn-diego-portatil',
    access_profile: 'internet_lan_full',
    framed_ip: '192.168.10.77',
  });
});

/* ------------------------------------ auditoria --------------------------------- */

const NEW_RANGES = {
  lan_restricted: { rangeStart: '', rangeEnd: '' },
  lan_full: { rangeStart: '', rangeEnd: '' },
  internet_only: { rangeStart: '192.168.10.100', rangeEnd: '192.168.10.109' },
  internet_lan_restricted: { rangeStart: '', rangeEnd: '' },
  internet_lan_full: { rangeStart: '192.168.10.75', rangeEnd: '192.168.10.99' },
};

test('PUT /ranges: audita quien, que y el antes/despues de los rangos', async () => {
  const res = await call('PUT', '/api/vpn-profiles/ranges', { ranges: NEW_RANGES });
  assert.equal(res.status, 200, res.text);

  assert.equal(db.audit.length, 1);
  const row = db.audit[0]!;
  assert.equal(row.admin_id, 7);
  assert.equal(row.admin_name, 'diego');
  assert.equal(row.action, 'update');
  assert.equal(row.entity, 'vpn_profile_ranges');
  const detail = row.detail as {
    before: Record<string, { rangeStart: string | null }>;
    after: Record<string, { rangeStart: string | null; rangeEnd: string | null }>;
  };
  assert.equal(detail.before.internet_only!.rangeStart, null);
  assert.deepEqual(detail.after.internet_only, {
    rangeStart: '192.168.10.100',
    rangeEnd: '192.168.10.109',
  });
  assert.equal(db.ranges.get('internet_only')?.range_start, '192.168.10.100');
});

test('PUT /ranges: un solape se rechaza con 400 y no deja ni cambio ni auditoria', async () => {
  const bad = {
    ...NEW_RANGES,
    lan_full: { rangeStart: '192.168.10.105', rangeEnd: '192.168.10.115' }, // pisa internet_only
  };
  const res = await call('PUT', '/api/vpn-profiles/ranges', { ranges: bad });
  assert.equal(res.status, 400);
  assert.match(String(res.json?.error ?? res.text), /se solapan/);
  assert.equal(db.audit.length, 0);
  assert.equal(db.ranges.has('internet_only'), false);
});

test('lista restringida: crear, editar y borrar auditan antes/despues', async () => {
  const created = await call('POST', '/api/vpn-profiles/destinations', {
    destCidr: '192.168.10.50',
    protocol: 'tcp',
    ports: '22, 443',
    comment: 'Ficheros',
  });
  assert.equal(created.status, 201, created.text);
  const id = Number(created.json?.id);

  const updated = await call('PUT', `/api/vpn-profiles/destinations/${id}`, {
    destCidr: '192.168.10.50',
    protocol: 'tcp',
    ports: '22',
    comment: 'Ficheros',
  });
  assert.equal(updated.status, 200, updated.text);

  const deleted = await call('DELETE', `/api/vpn-profiles/destinations/${id}`);
  assert.equal(deleted.status, 200, deleted.text);

  assert.deepEqual(
    db.audit.map((a) => [a.action, a.entity, a.entity_id, a.admin_name]),
    [
      ['create', 'vpn_restricted_destination', String(id), 'diego'],
      ['update', 'vpn_restricted_destination', String(id), 'diego'],
      ['delete', 'vpn_restricted_destination', String(id), 'diego'],
    ],
  );
  const [c, u, d] = db.audit.map(
    (a) =>
      a.detail as {
        before: { ports: string | null } | null;
        after: { ports: string | null } | null;
      },
  );
  assert.equal(c!.before, null);
  assert.equal(c!.after?.ports, '22,443');
  assert.equal(u!.before?.ports, '22,443');
  assert.equal(u!.after?.ports, '22');
  assert.equal(d!.before?.ports, '22');
  assert.equal(d!.after, null);
});

test('lista restringida: una entrada invalida se rechaza (400) sin auditoria ni escritura', async () => {
  const res = await call('POST', '/api/vpn-profiles/destinations', {
    destCidr: '192.168.10.5; flush ruleset',
    protocol: 'tcp',
  });
  assert.equal(res.status, 400);
  assert.equal(db.audit.length, 0);
  assert.equal(db.destinations.size, 0);
});

test('PATCH access-profile: cambia perfil e IP, desconecta y audita antes/despues y el resultado de la desconexion', async () => {
  db.ranges.set('internet_only', { range_start: '192.168.10.100', range_end: '192.168.10.109' });
  const res = await call('PATCH', '/api/vpn-devices/vpn-diego-portatil/access-profile', {
    accessProfile: 'internet_only',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal((res.json?.after as { framedIp: string }).framedIp, '192.168.10.100');

  assert.equal(db.audit.length, 1);
  const row = db.audit[0]!;
  assert.equal(row.admin_name, 'diego');
  assert.equal(row.entity, 'vpn_device_access_profile');
  assert.equal(row.entity_id, 'vpn-diego-portatil');
  assert.deepEqual(row.detail, {
    before: { accessProfile: 'internet_lan_full', framedIp: '192.168.10.77' },
    after: { accessProfile: 'internet_only', framedIp: '192.168.10.100' },
    disconnect: { attempted: true, ok: true, sessions: 0, error: null },
  });
  assert.equal(db.radreply.get('vpn-diego-portatil'), '192.168.10.100');
});

test('PATCH access-profile: sin cambio real no se audita', async () => {
  const res = await call('PATCH', '/api/vpn-devices/vpn-diego-portatil/access-profile', {
    accessProfile: 'internet_lan_full',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json?.changed, false);
  assert.equal(db.audit.length, 0);
});

test('PATCH access-profile: perfil desconocido -> 400', async () => {
  const res = await call('PATCH', '/api/vpn-devices/vpn-diego-portatil/access-profile', {
    accessProfile: 'root',
  });
  assert.equal(res.status, 400);
  assert.equal(db.audit.length, 0);
});

test('GET /nft: descarga el fichero de sets (solo flush set + add element) y audita la descarga', async () => {
  db.ranges.set('internet_only', { range_start: '192.168.10.100', range_end: '192.168.10.109' });
  const res = await call('GET', '/api/vpn-profiles/nft');
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get('content-disposition') ?? '',
    /attachment; filename="vpn-profiles\.nft"/,
  );
  assert.match(res.text, /^flush set inet filter vpn_internet_only_ips$/m);
  assert.match(
    res.text,
    /^add element inet filter vpn_internet_only_ips \{ 192\.168\.10\.100-192\.168\.10\.109 \}$/m,
  );
  assert.doesNotMatch(res.text, /^(table|chain|delete|add rule|flush ruleset)/m);
  assert.deepEqual(
    db.audit.map((a) => a.entity_id),
    ['download'],
  );
});

test('GET /nftables-fragment: descarga el fragmento para revisar (sets vacios + reglas fijas) y lo audita', async () => {
  const res = await call('GET', '/api/vpn-profiles/nftables-fragment');
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get('content-disposition') ?? '',
    /filename="nftables-fragmento-perfiles\.conf"/,
  );
  assert.match(res.text, /PARTE 1/);
  assert.match(res.text, /set vpn_lan_full_ips \{/);
  assert.doesNotMatch(res.text, /elements/);
  assert.deepEqual(
    db.audit.map((a) => a.entity_id),
    ['fragment-download'],
  );
});

test('GET /: devuelve perfiles, rangos, lista y avisos para la interfaz', async () => {
  const res = await call('GET', '/api/vpn-profiles');
  assert.equal(res.status, 200);
  const json = res.json as {
    profiles: { profile: string; infrastructureAccess: boolean }[];
    infrastructureWarning: string;
  };
  assert.equal(json.profiles.length, 5);
  assert.deepEqual(
    json.profiles.filter((p) => p.infrastructureAccess).map((p) => p.profile),
    ['lan_full', 'internet_lan_full'],
  );
  assert.equal(json.infrastructureWarning, 'acceso a infraestructura: CA, RADIUS y BD');
});
