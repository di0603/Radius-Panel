-- ---------------------------------------------------------------------------
-- Ajustes finales al modelo de CLAUDE.md (correccion 4.5) que todavia
-- faltaban: identidad AAA y URL del endpoint EST en panel_vpn_settings, y
-- renombrar panel_vpn_enroll_tokens.token_hash a token_sha256.
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-4.5.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente y NO destructiva: nunca borra tablas ni filas (correccion
-- 4.6). Requiere MariaDB (ADD/DROP COLUMN IF [NOT] EXISTS, 10.0.2+).
--
-- panel_vpn_settings puede tener ya una fila real con ajustes personalizados,
-- asi que se amplia con ALTER normal. panel_vpn_enroll_tokens no tiene ningun
-- token real emitido todavia (el modulo no se ha desplegado), pero por si
-- hubiera alguno de pruebas, su hash se copia a la columna nueva antes de
-- retirar la antigua en vez de recrear la tabla.
--
-- Correccion 8.6: en una instalacion nueva, panel-schema-vpn.sql ya crea
-- panel_vpn_enroll_tokens con token_sha256 desde el principio y sin
-- token_hash (ese nombre solo existio en el esquema anterior a la
-- correccion 4.5). El UPDATE de mas abajo referenciaba token_hash sin
-- condicion, asi que fallaba con "Unknown column 'token_hash' in 'WHERE'"
-- en cualquier instalacion que nunca tuvo esa columna. Se comprueba antes en
-- information_schema.COLUMNS y solo se prepara/ejecuta el UPDATE si existe;
-- si no, se prepara un SELECT 1 inocuo. Sigue sin borrar nada.
-- ---------------------------------------------------------------------------

ALTER TABLE panel_vpn_settings
  ADD COLUMN IF NOT EXISTS aaa_id VARCHAR(255) NOT NULL DEFAULT 'CN=radius.vpn.vlc.didev.es' AFTER vpn_fqdn,
  ADD COLUMN IF NOT EXISTS est_url VARCHAR(255) NOT NULL DEFAULT 'https://pki.vlc.didev.es:8443';

ALTER TABLE panel_vpn_enroll_tokens
  ADD COLUMN IF NOT EXISTS token_sha256 CHAR(64) NULL DEFAULT NULL;

SET @vpn45_token_hash_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'panel_vpn_enroll_tokens' AND COLUMN_NAME = 'token_hash'
);

SET @vpn45_copy_token_hash_sql = IF(
  @vpn45_token_hash_exists > 0,
  'UPDATE panel_vpn_enroll_tokens SET token_sha256 = token_hash WHERE token_sha256 IS NULL AND token_hash IS NOT NULL',
  'SELECT 1'
);

PREPARE vpn45_copy_token_hash_stmt FROM @vpn45_copy_token_hash_sql;
EXECUTE vpn45_copy_token_hash_stmt;
DEALLOCATE PREPARE vpn45_copy_token_hash_stmt;

ALTER TABLE panel_vpn_enroll_tokens
  MODIFY COLUMN token_sha256 CHAR(64) NOT NULL,
  ADD UNIQUE INDEX IF NOT EXISTS token_sha256 (token_sha256),
  DROP COLUMN IF EXISTS token_hash,
  DROP COLUMN IF EXISTS revoked_at,
  DROP INDEX IF EXISTS token_hash;
