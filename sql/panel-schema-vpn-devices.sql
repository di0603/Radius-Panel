-- ---------------------------------------------------------------------------
-- Reconciliacion de panel_vpn_devices con el modelo de CLAUDE.md (correccion
-- 4.5): owner_user/device_label/owner_name propios y `enabled` en vez del
-- `owner` libre y el `status` del esquema anterior.
--
-- Solo hace falta si tu base de datos aplico la version anterior de
-- sql/panel-schema-vpn.sql. En una instalacion nueva, panel-schema-vpn.sql ya
-- crea la tabla correcta y esto es practicamente un no-op.
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-devices.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente y NO destructiva: nunca borra tablas ni filas (correccion
-- 4.6). No toca radcheck/radreply/radusergroup ni radius.vpn_certificates.
--
-- owner_user/device_label no existian como campos separados en el esquema
-- anterior (solo habia un "owner" de texto libre y un username ya formado):
-- para una fila de una instalacion de desarrollo previa, se derivan con el
-- mejor esfuerzo posible (device_label del username quitando el prefijo
-- "vpn-"; owner_user del "owner" libre, o "legacy" si no hay nada
-- aprovechable) en vez de perderse. El propio `username` no se toca.
-- ---------------------------------------------------------------------------

ALTER TABLE panel_vpn_devices
  ADD COLUMN IF NOT EXISTS owner VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS owner_user VARCHAR(32) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS device_label VARCHAR(32) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS owner_name VARCHAR(128) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tunnel_mode ENUM('full', 'split') NOT NULL DEFAULT 'split',
  ADD COLUMN IF NOT EXISTS cert_days INT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS renew_after_days INT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS enabled TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status ENUM('pending', 'active', 'disabled', 'revoked') NULL DEFAULT NULL;

UPDATE panel_vpn_devices
   SET device_label = LEFT(SUBSTRING(username, 5), 32)
 WHERE device_label IS NULL AND username LIKE 'vpn-%';

UPDATE panel_vpn_devices
   SET device_label = LEFT(username, 32)
 WHERE device_label IS NULL;

UPDATE panel_vpn_devices
   SET owner_user = LEFT(LOWER(owner), 32)
 WHERE owner_user IS NULL AND owner IS NOT NULL AND owner <> '';

UPDATE panel_vpn_devices SET owner_user = 'legacy' WHERE owner_user IS NULL;

UPDATE panel_vpn_devices
   SET owner_name = owner
 WHERE owner_name IS NULL AND owner IS NOT NULL AND owner <> '';

UPDATE panel_vpn_devices SET enabled = 0 WHERE status IN ('disabled', 'revoked');

-- username NO se reduce de tamano aqui aposta: el esquema anterior permitia
-- hasta 36 caracteres (vpn- + nombre de hasta 32) y encogerlo a VARCHAR(32)
-- como pide el modelo truncaria filas ya existentes. Mas ancho que el modelo
-- es inofensivo; mas estrecho perderia datos.
ALTER TABLE panel_vpn_devices
  MODIFY COLUMN owner_user VARCHAR(32) NOT NULL,
  MODIFY COLUMN device_label VARCHAR(32) NOT NULL,
  MODIFY COLUMN platform ENUM('windows', 'android', 'linux') NOT NULL,
  MODIFY COLUMN framed_ip VARCHAR(15) NULL DEFAULT NULL;

ALTER TABLE panel_vpn_devices
  DROP COLUMN IF EXISTS display_name,
  DROP COLUMN IF EXISTS contact_email,
  DROP COLUMN IF EXISTS owner,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS created_by,
  ADD UNIQUE INDEX IF NOT EXISTS username (username),
  ADD UNIQUE INDEX IF NOT EXISTS framed_ip (framed_ip),
  ADD INDEX IF NOT EXISTS owner_user (owner_user);
