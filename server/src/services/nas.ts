import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { radiusPool } from '../db/pools.js';
import { notFound } from '../lib/http.js';

export interface Nas {
  id: number;
  nasname: string;
  shortname: string | null;
  type: string | null;
  ports: number | null;
  secret: string;
  server: string | null;
  community: string | null;
  description: string | null;
}

export interface NasWriteInput {
  nasname: string;
  shortname?: string | null;
  type?: string | null;
  ports?: number | null;
  secret: string;
  server?: string | null;
  community?: string | null;
  description?: string | null;
}

export async function listNas(): Promise<Nas[]> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(`SELECT * FROM nas ORDER BY nasname`);
  return rows as Nas[];
}

export async function getNas(id: number): Promise<Nas> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(`SELECT * FROM nas WHERE id = :id`, {
    id,
  });
  if (!rows.length) throw notFound(`No existe el NAS ${id}`);
  return rows[0] as Nas;
}

export async function getNasByIp(ip: string): Promise<Nas | null> {
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT * FROM nas WHERE nasname = :ip LIMIT 1`,
    { ip },
  );
  return rows.length ? (rows[0] as Nas) : null;
}

export async function createNas(input: NasWriteInput): Promise<Nas> {
  const [res] = await radiusPool.query<ResultSetHeader>(
    `INSERT INTO nas (nasname, shortname, type, ports, secret, server, community, description)
     VALUES (:nasname, :shortname, :type, :ports, :secret, :server, :community, :description)`,
    {
      nasname: input.nasname,
      shortname: input.shortname ?? null,
      type: input.type ?? 'other',
      ports: input.ports ?? null,
      secret: input.secret,
      server: input.server ?? null,
      community: input.community ?? null,
      description: input.description ?? 'RADIUS Client',
    },
  );
  return getNas(res.insertId);
}

export async function updateNas(id: number, input: NasWriteInput): Promise<Nas> {
  await getNas(id);
  await radiusPool.query(
    `UPDATE nas SET nasname = :nasname, shortname = :shortname, type = :type, ports = :ports,
       secret = :secret, server = :server, community = :community, description = :description
     WHERE id = :id`,
    {
      id,
      nasname: input.nasname,
      shortname: input.shortname ?? null,
      type: input.type ?? 'other',
      ports: input.ports ?? null,
      secret: input.secret,
      server: input.server ?? null,
      community: input.community ?? null,
      description: input.description ?? 'RADIUS Client',
    },
  );
  return getNas(id);
}

export async function deleteNas(id: number): Promise<void> {
  await getNas(id);
  await radiusPool.query(`DELETE FROM nas WHERE id = :id`, { id });
}
