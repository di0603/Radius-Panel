import type { RowDataPacket } from 'mysql2';
import { config } from '../config.js';
import { radiusPool } from '../db/pools.js';
import { ApiError } from '../lib/http.js';
import { sendDisconnect } from '../lib/radiusPacket.js';
import { getSessionByUniqueId } from './accounting.js';
import { getNasByIp } from './nas.js';

export interface DisconnectOutcome {
  acctuniqueid: string;
  username: string;
  nasipaddress: string;
  result: string;
  acknowledged: boolean;
}

/**
 * Envia un Disconnect-Request (RFC 5176) al NAS que sirve una sesion activa.
 * El `secret` se toma de la tabla `nas` buscando por IP.
 */
export async function disconnectSession(acctuniqueid: string): Promise<DisconnectOutcome> {
  if (!config.coa.enabled) {
    throw new ApiError(503, 'La desconexion de sesiones esta deshabilitada (COA_ENABLED=false)');
  }

  const session = await getSessionByUniqueId(acctuniqueid);
  if (session.acctstoptime) {
    throw new ApiError(409, 'La sesion ya esta cerrada');
  }

  const nas = await getNasByIp(session.nasipaddress);
  if (!nas) {
    throw new ApiError(
      422,
      `No hay un NAS registrado con IP ${session.nasipaddress}; no se conoce el secret para el Disconnect`,
    );
  }

  const res = await sendDisconnect({
    host: session.nasipaddress,
    port: config.coa.port,
    secret: nas.secret,
    timeoutMs: config.coa.timeoutMs,
    attributes: {
      userName: session.username || undefined,
      nasIpAddress: session.nasipaddress || undefined,
      acctSessionId: session.acctsessionid || undefined,
      framedIpAddress: session.framedipaddress || undefined,
      callingStationId: session.callingstationid || undefined,
    },
  });

  return {
    acctuniqueid,
    username: session.username,
    nasipaddress: session.nasipaddress,
    result: res.codeName,
    acknowledged: res.ok,
  };
}

/** Desconecta todas las sesiones activas de un usuario. */
export async function disconnectUserSessions(username: string): Promise<{
  total: number;
  results: DisconnectOutcome[];
  errors: { acctuniqueid: string; error: string }[];
}> {
  if (!config.coa.enabled) {
    throw new ApiError(503, 'La desconexion de sesiones esta deshabilitada (COA_ENABLED=false)');
  }
  const [rows] = await radiusPool.query<RowDataPacket[]>(
    `SELECT acctuniqueid FROM radacct WHERE username = :u AND acctstoptime IS NULL`,
    { u: username },
  );
  const results: DisconnectOutcome[] = [];
  const errors: { acctuniqueid: string; error: string }[] = [];
  for (const r of rows) {
    const id = String(r.acctuniqueid);
    try {
      results.push(await disconnectSession(id));
    } catch (err) {
      errors.push({ acctuniqueid: id, error: (err as Error).message });
    }
  }
  return { total: rows.length, results, errors };
}
