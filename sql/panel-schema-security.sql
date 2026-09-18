-- ---------------------------------------------------------------------------
-- Ampliacion de seguridad del panel (refresh tokens, bloqueo de cuenta, 2FA).
--
-- Aplicar ANTES de arrancar la version del servidor que lo usa:
--   mysql -u root -p radius_panel < sql/panel-schema-security.sql
--
-- Es idempotente: se puede ejecutar varias veces sin romper nada.
-- Para instalaciones nuevas no hace falta, ya va incluido en panel-schema.sql.
-- ---------------------------------------------------------------------------

-- Helper: anade una columna solo si no existe (MySQL no tiene ADD COLUMN IF NOT EXISTS).
DROP PROCEDURE IF EXISTS panel_add_column;
DELIMITER $$
CREATE PROCEDURE panel_add_column(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN ', ddl);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

--
-- Bloqueo de cuenta tras N intentos fallidos.
--
CALL panel_add_column('panel_admins', 'failed_attempts',
  'failed_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0');
CALL panel_add_column('panel_admins', 'locked_until',
  'locked_until DATETIME NULL DEFAULT NULL');

--
-- 2FA (TOTP). El secreto se guarda cifrado con AES-256-GCM derivado de JWT_SECRET,
-- nunca en claro. totp_enabled solo pasa a 1 cuando el admin confirma un codigo.
--
CALL panel_add_column('panel_admins', 'totp_secret',
  'totp_secret VARCHAR(255) NULL DEFAULT NULL');
CALL panel_add_column('panel_admins', 'totp_enabled',
  'totp_enabled TINYINT(1) NOT NULL DEFAULT 0');

--
-- Fecha del ultimo cambio de contrasena (para politicas de caducidad).
--
CALL panel_add_column('panel_admins', 'password_changed_at',
  'password_changed_at DATETIME NULL DEFAULT NULL');

DROP PROCEDURE IF EXISTS panel_add_column;

--
-- Sesiones del panel: un registro por refresh token emitido.
-- Se guarda solo el hash SHA-256 del token, nunca el token en claro.
-- Permite listar las sesiones abiertas y revocarlas una a una.
--
CREATE TABLE IF NOT EXISTS panel_refresh_tokens (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id     INT UNSIGNED NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  family       CHAR(36)     NOT NULL,
  expires_at   DATETIME     NOT NULL,
  revoked_at   DATETIME     NULL DEFAULT NULL,
  last_used_at DATETIME     NULL DEFAULT NULL,
  ip           VARCHAR(45)  NOT NULL DEFAULT '',
  user_agent   VARCHAR(255) NOT NULL DEFAULT '',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY token_hash (token_hash),
  KEY admin_id (admin_id),
  KEY family (family),
  KEY expires_at (expires_at)
) ENGINE=InnoDB;

--
-- Intentos de acceso al panel (correctos y fallidos).
-- Sirve para el rate-limit por usuario y para investigar ataques de fuerza bruta.
--
CREATE TABLE IF NOT EXISTS panel_login_attempts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username   VARCHAR(64) NOT NULL,
  ip         VARCHAR(45) NOT NULL DEFAULT '',
  success    TINYINT(1)  NOT NULL DEFAULT 0,
  reason     VARCHAR(32) NOT NULL DEFAULT '',
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY username_created (username, created_at),
  KEY created_at (created_at)
) ENGINE=InnoDB;
