-- ---------------------------------------------------------------------------
-- Ajustes finales al modelo de CLAUDE.md (correccion 4.5) que todavia
-- faltaban: identidad AAA y URL del endpoint EST en panel_vpn_settings, y
-- renombrar panel_vpn_enroll_tokens.token_hash a token_sha256.
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-4.5.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. Requiere MariaDB (ADD/DROP COLUMN IF [NOT] EXISTS, 10.0.2+).
--
-- panel_vpn_settings puede tener ya una fila real con ajustes personalizados,
-- asi que aqui se amplia con ALTER en vez de recrear la tabla.
-- panel_vpn_enroll_tokens no tiene ningun token real emitido todavia (el
-- modulo no se ha desplegado), asi que se recrea vacia con el nombre de
-- columna correcto.
-- ---------------------------------------------------------------------------

ALTER TABLE panel_vpn_settings
  ADD COLUMN IF NOT EXISTS aaa_id VARCHAR(255) NOT NULL DEFAULT 'CN=radius.vpn.vlc.didev.es' AFTER vpn_fqdn,
  ADD COLUMN IF NOT EXISTS est_url VARCHAR(255) NOT NULL DEFAULT 'https://pki.vlc.didev.es:8443';

DROP TABLE IF EXISTS panel_vpn_enroll_tokens;

CREATE TABLE panel_vpn_enroll_tokens (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32) NOT NULL,
  token_sha256  CHAR(64) NOT NULL,
  expires_at    DATETIME NOT NULL,
  used_at       DATETIME NULL DEFAULT NULL,
  created_by    INT UNSIGNED NULL DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY token_sha256 (token_sha256),
  KEY username (username)
) ENGINE=InnoDB;
