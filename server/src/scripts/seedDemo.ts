/**
 * Rellena la base RADIUS con datos de demostracion para probar el panel sin un
 * FreeRADIUS real.
 *
 *   npm --prefix server run seed:demo            (aborta si ya hay usuarios)
 *   npm --prefix server run seed:demo -- --force (inserta igualmente)
 *
 * NO usar en produccion.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { radiusPool, closePools } from '../db/pools.js';

const force = process.argv.includes('--force');

const GROUPS: Record<string, { attr: string; op: string; value: string }[]> = {
  'plan-10m': [
    { attr: 'Mikrotik-Rate-Limit', op: ':=', value: '10M/10M' },
    { attr: 'Session-Timeout', op: ':=', value: '86400' },
  ],
  'plan-50m': [
    { attr: 'Mikrotik-Rate-Limit', op: ':=', value: '50M/50M' },
    { attr: 'Session-Timeout', op: ':=', value: '86400' },
  ],
  hotspot: [
    { attr: 'Session-Timeout', op: ':=', value: '7200' },
    { attr: 'Idle-Timeout', op: ':=', value: '600' },
  ],
};

const NAS = [
  { nasname: '10.0.0.1', shortname: 'mikrotik-central', type: 'other', secret: 'demo-secret-1' },
  { nasname: '10.0.0.2', shortname: 'ap-planta1', type: 'other', secret: 'demo-secret-2' },
];

function rint(a: number, b: number): number {
  return a + Math.floor(Math.random() * (b - a + 1));
}
function pick<T>(arr: T[]): T {
  return arr[rint(0, arr.length - 1)];
}
function mysqlDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function main(): Promise<void> {
  const [existing] = await radiusPool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM radcheck`);
  if (Number(existing[0].n) > 0 && !force) {
    console.error(
      `radcheck ya tiene ${existing[0].n} filas. Usa "-- --force" si quieres insertar datos demo igualmente.`,
    );
    process.exit(1);
  }

  // Grupos
  for (const [groupname, attrs] of Object.entries(GROUPS)) {
    for (const a of attrs) {
      await radiusPool.query(
        `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (:g, :a, :o, :v)`,
        { g: groupname, a: a.attr, o: a.op, v: a.value },
      );
    }
  }
  console.log(`✔ ${Object.keys(GROUPS).length} grupos`);

  // NAS
  for (const n of NAS) {
    await radiusPool.query(
      `INSERT INTO nas (nasname, shortname, type, secret, description)
       VALUES (:nasname, :shortname, :type, :secret, 'demo')`,
      n,
    );
  }
  console.log(`✔ ${NAS.length} NAS`);

  // Usuarios
  const groupNames = Object.keys(GROUPS);
  const users: string[] = [];
  for (let i = 1; i <= 15; i++) {
    const username = `demo${String(i).padStart(2, '0')}`;
    users.push(username);
    await radiusPool.query(
      `INSERT INTO radcheck (username, attribute, op, value) VALUES (:u, 'Cleartext-Password', ':=', :p)`,
      { u: username, p: `pass${i}` },
    );
    if (i % 5 === 0) {
      await radiusPool.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES (:u, 'Auth-Type', ':=', 'Reject')`,
        { u: username },
      );
    }
    await radiusPool.query(
      `INSERT INTO radusergroup (username, groupname, priority) VALUES (:u, :g, 1)`,
      { u: username, g: groupNames[i % groupNames.length] },
    );
  }
  console.log(`✔ ${users.length} usuarios`);

  // postauth (90 dias)
  let auths = 0;
  for (let d = 90; d >= 0; d--) {
    for (let k = 0; k < rint(3, 25); k++) {
      const when = new Date();
      when.setDate(when.getDate() - d);
      when.setHours(rint(0, 23), rint(0, 59), rint(0, 59));
      const reject = Math.random() < 0.15;
      await radiusPool.query(
        `INSERT INTO radpostauth (username, pass, reply, authdate)
         VALUES (:u, '', :r, :t)`,
        { u: pick(users), r: reject ? 'Access-Reject' : 'Access-Accept', t: mysqlDate(when) },
      );
      auths++;
    }
  }
  console.log(`✔ ${auths} filas en radpostauth`);

  // accounting (90 dias, algunas sesiones abiertas)
  let acct = 0;
  for (let d = 90; d >= 0; d--) {
    for (let k = 0; k < rint(2, 12); k++) {
      const start = new Date();
      start.setDate(start.getDate() - d);
      start.setHours(rint(0, 23), rint(0, 59), rint(0, 59));
      const open = d === 0 && Math.random() < 0.5;
      const durationS = rint(60, 6 * 3600);
      const stop = open ? null : new Date(start.getTime() + durationS * 1000);
      const inOct = rint(1e6, 5e9);
      const outOct = rint(1e6, 8e9);
      const u = pick(users);
      const nas = pick(NAS).nasname;
      await radiusPool.query(
        `INSERT INTO radacct
          (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctupdatetime,
           acctstoptime, acctsessiontime, acctinputoctets, acctoutputoctets,
           callingstationid, framedipaddress, acctterminatecause)
         VALUES (:sid, :uid, :u, :nas, :start, :upd, :stop, :dur, :ino, :outo, :mac, :fip, :cause)`,
        {
          sid: crypto.randomBytes(6).toString('hex'),
          uid: crypto.randomBytes(16).toString('hex'),
          u,
          nas,
          start: mysqlDate(start),
          upd: mysqlDate(stop ?? new Date()),
          stop: stop ? mysqlDate(stop) : null,
          dur: open ? Math.floor((Date.now() - start.getTime()) / 1000) : durationS,
          ino: inOct,
          outo: outOct,
          mac: `AA:BB:CC:${rint(16, 99)}:${rint(16, 99)}:${rint(16, 99)}`,
          fip: `100.64.${rint(0, 255)}.${rint(1, 254)}`,
          cause: open
            ? ''
            : pick([
                'User-Request',
                'Idle-Timeout',
                'Session-Timeout',
                'NAS-Reboot',
                'Lost-Carrier',
              ]),
        },
      );
      acct++;
    }
  }
  console.log(`✔ ${acct} filas en radacct`);

  await closePools();
  console.log('\nDatos demo cargados. Recarga el panel.');
  process.exit(0);
}

void main();
