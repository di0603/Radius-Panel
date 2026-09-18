import type { Request } from 'express';
import { panelPool } from '../db/pools.js';

type AuditAction = 'create' | 'update' | 'delete' | 'disconnect' | 'login';

/**
 * Registra una operacion de escritura en panel_audit_log.
 * Nunca lanza: un fallo de auditoria no debe tumbar la peticion.
 */
export async function writeAudit(
  req: Request,
  action: AuditAction,
  entity: string,
  entityId: string | number,
  detail?: unknown,
): Promise<void> {
  try {
    await panelPool.query(
      `INSERT INTO panel_audit_log (admin_id, admin_name, action, entity, entity_id, detail, ip)
       VALUES (:admin_id, :admin_name, :action, :entity, :entity_id, :detail, :ip)`,
      {
        admin_id: req.auth?.sub ?? null,
        admin_name: req.auth?.username ?? '',
        action,
        entity,
        entity_id: String(entityId),
        detail: detail === undefined ? null : JSON.stringify(detail),
        ip: req.ip ?? '',
      },
    );
  } catch (err) {
    console.error('[audit] no se pudo registrar', err);
  }
}
